'use strict';
// db.js —— 唯一 SQL 层：连接/PRAGMA/迁移/全部 prepared DAO。
//
// 铁律：
// 1. SQL 不出此文件（PostgreSQL 迁移只动此层，方言保持 ANSI 化）。
// 2. daily_user 的列分两类——事件派生列（sessions/session_ms/runs_*/failures/run_active_ms，
//    可从 events 重算）与 ingest-only 列（heartbeats：心跳不落 events，物理不可重算），
//    recompute 的 SET 列表永不包含 heartbeats，也绝不 DELETE+重建 daily 行。
// 3. 数值净化口径双端一致：payload 里的 ms 值仅当为正数时计入（JS 侧 msOf 与
//    SQL 侧 typeof(...) IN ('integer','real') AND > 0 同义），避免夜间补算把
//    ingest 已拒绝的垃圾值"补"回去。

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// payload ms 值净化 SQL 片段（口径见文件头铁律 3）
function msExpr(field) {
  const j = "json_extract(payload, '$." + field + "')";
  return "CASE WHEN typeof(" + j + ") IN ('integer', 'real') AND " + j + ' > 0 THEN ' + j + ' ELSE 0 END';
}
// tool 名净化 SQL 片段：缺失/空串归 'unknown'（与 ingest.js 的 toolOf 同口径）
const TOOL_EXPR = "COALESCE(NULLIF(CAST(json_extract(payload, '$.tool') AS TEXT), ''), 'unknown')";

const DDL_V1 = `
-- 安装/实例注册表（心跳只 upsert 此表 + daily_user 计数，不落 events）
CREATE TABLE installs (
  install_id TEXT PRIMARY KEY,
  user TEXT, host TEXT, platform TEXT, app_version TEXT, channel TEXT,
  first_seen TEXT, last_seen TEXT, live_sessions INTEGER DEFAULT 0
);

-- 原始事件（session/run/failure；保留 OPS_RETENTION_DAYS 天，默认 90）
-- day 为写入时用服务器本地时区固化的归属日（YYYY-MM-DD），聚合/清理只认此列
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,
  install_id TEXT, user TEXT, host TEXT,
  type TEXT, client_ts TEXT, server_ts TEXT,
  day TEXT,
  app_version TEXT, payload TEXT
);
-- 索引口径：所有 stats 查询按 day 过滤（非 server_ts），故索引以 day 为先导列。
-- ix_events_day 服务清理(day<cutoff)与夜间补算(day>=from 全类型 GROUP BY)。
-- 下面两个 partial 覆盖索引只索引失败/终态子集（占比小），压测实测把
-- byVersion 从 15s 降到 91ms、recent 列表降到 0.2ms（详见 scripts/bench.js 验收线）：
--   · ix_runend_ver：run 失败率的分母（bp_run_end 按版本计数），(day, app_version) 覆盖。
--   · ix_fail_recent：最近失败列表，(day, server_ts) 配合 ORDER BY day DESC, server_ts DESC 反向扫 + LIMIT。
-- 不设 (type, server_ts) 索引：无查询按 server_ts 过滤，那样只会白白加重写路径。
CREATE INDEX ix_events_day ON events(day);
CREATE INDEX ix_runend_ver ON events(day, app_version) WHERE type = 'bp_run_end';
CREATE INDEX ix_fail_recent ON events(day, server_ts) WHERE type = 'failure_event';

-- 日聚合（永久保留；ingest 增量 upsert，夜间 job 核对补算——heartbeats 除外）
-- in_tokens/out_tokens 来自 session_end（token 总量权威；run 级 token 归入 daily_blueprint，防双计）
CREATE TABLE daily_user (
  day TEXT, install_id TEXT, user TEXT, host TEXT,
  heartbeats INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0, session_ms INTEGER DEFAULT 0,
  runs_done INTEGER DEFAULT 0, runs_failed INTEGER DEFAULT 0, runs_halted INTEGER DEFAULT 0,
  failures INTEGER DEFAULT 0, run_active_ms INTEGER DEFAULT 0,
  in_tokens INTEGER DEFAULT 0, out_tokens INTEGER DEFAULT 0,
  PRIMARY KEY (day, install_id)
);

-- 工具维度日聚合（/v1/stats/tools 的毫秒级路径；几千行量级，永久保留，可从 events 重算）
CREATE TABLE daily_tool (
  day TEXT, tool TEXT,
  sessions INTEGER DEFAULT 0, session_ms INTEGER DEFAULT 0,
  PRIMARY KEY (day, tool)
);

-- 失败维度日聚合（/v1/stats/failures 的 kinds 分布与按版本失败数）。
-- 直接对 events 做 json_extract(kind) GROUP BY 在 day 范围上要走临时 B 树重排（30 天 11.7 万行 ≈ 1s，
-- 收窗口也压不到 300ms），故与 daily_tool 同法预聚合成小表（天×版本×kind，年级几万行），读时亚毫秒。
-- 失败率的分母（总 run 数按版本）仍从 events 走 ix_runend_ver 覆盖索引取（91ms）。
CREATE TABLE daily_fail (
  day TEXT, app_version TEXT, kind TEXT,
  failures INTEGER DEFAULT 0,
  PRIMARY KEY (day, app_version, kind)
);

-- 工作流（对外术语；内部 = blueprint）维度日聚合。来自 bp_run_end（runs/active_ms/中断/token）
-- 与带 blueprintId 的 failure_event（failures 归因）。天×工作流数，永久保留，可从 events 重算。
-- in_tokens/out_tokens 是「按工作流归因的 run 级 token 子集」，与 daily_user 总量不重复求和。
CREATE TABLE daily_blueprint (
  day TEXT, blueprint_id TEXT,
  runs_done INTEGER DEFAULT 0, runs_failed INTEGER DEFAULT 0, runs_halted INTEGER DEFAULT 0,
  failures INTEGER DEFAULT 0, active_ms INTEGER DEFAULT 0, interruptions INTEGER DEFAULT 0,
  in_tokens INTEGER DEFAULT 0, out_tokens INTEGER DEFAULT 0,
  PRIMARY KEY (day, blueprint_id)
);

-- 心跳幂等去重（心跳不落 events，spool 补发的重发靠此表挡；保留 7 天，夜间清理）
CREATE TABLE hb_seen (
  event_id TEXT PRIMARY KEY,
  day TEXT
);
CREATE INDEX ix_hb_seen_day ON hb_seen(day);

-- 服务器自身状态（夜间 job 记账：last_job_day / last_job_at / last_job_result）
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const MIGRATIONS = [
  { version: 1, sql: DDL_V1 },
  // 未来 v2（tickets 表等）在此追加 { version: 2, sql: ... }
];

function runMigrations(db) {
  for (const m of MIGRATIONS) {
    if (db.pragma('user_version', { simple: true }) >= m.version) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma('user_version = ' + m.version);
    })();
    console.log('[db] migrated to v' + m.version);
  }
}

function makeDao(db) {
  // ---- 写路径（ingest） ----

  const stInsertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (event_id, install_id, user, host, type, client_ts, server_ts, day, app_version, payload)
    VALUES (@eventId, @installId, @user, @host, @type, @clientTs, @serverTs, @day, @appVersion, @payload)`);

  // platform/app_version/channel 用 COALESCE 防缺字段事件把已知信息冲成 NULL；
  // live_sessions 仅 heartbeat/instance_online 携带（其余事件传 null 不覆盖）
  const stUpsertInstall = db.prepare(`
    INSERT INTO installs (install_id, user, host, platform, app_version, channel, first_seen, last_seen, live_sessions)
    VALUES (@installId, @user, @host, @platform, @appVersion, @channel, @nowIso, @nowIso, COALESCE(@liveSessions, 0))
    ON CONFLICT(install_id) DO UPDATE SET
      user = excluded.user,
      host = excluded.host,
      platform = COALESCE(excluded.platform, platform),
      app_version = COALESCE(excluded.app_version, app_version),
      channel = COALESCE(excluded.channel, channel),
      last_seen = excluded.last_seen,
      live_sessions = COALESCE(@liveSessions, live_sessions)`);

  const stMarkHbSeen = db.prepare('INSERT OR IGNORE INTO hb_seen (event_id, day) VALUES (?, ?)');

  // 单条 upsert 吃下全部计数列（不相干列传 0）；"仅确保行存在" = 全 0 调用
  const stBumpDaily = db.prepare(`
    INSERT INTO daily_user (day, install_id, user, host, heartbeats, sessions, session_ms,
                            runs_done, runs_failed, runs_halted, failures, run_active_ms,
                            in_tokens, out_tokens)
    VALUES (@day, @installId, @user, @host, @heartbeats, @sessions, @sessionMs,
            @runsDone, @runsFailed, @runsHalted, @failures, @runActiveMs,
            @inTokens, @outTokens)
    ON CONFLICT(day, install_id) DO UPDATE SET
      user = excluded.user,
      host = excluded.host,
      heartbeats = heartbeats + excluded.heartbeats,
      sessions = sessions + excluded.sessions,
      session_ms = session_ms + excluded.session_ms,
      runs_done = runs_done + excluded.runs_done,
      runs_failed = runs_failed + excluded.runs_failed,
      runs_halted = runs_halted + excluded.runs_halted,
      failures = failures + excluded.failures,
      run_active_ms = run_active_ms + excluded.run_active_ms,
      in_tokens = in_tokens + excluded.in_tokens,
      out_tokens = out_tokens + excluded.out_tokens`);

  const stBumpDailyTool = db.prepare(`
    INSERT INTO daily_tool (day, tool, sessions, session_ms)
    VALUES (@day, @tool, @sessions, @sessionMs)
    ON CONFLICT(day, tool) DO UPDATE SET
      sessions = sessions + excluded.sessions,
      session_ms = session_ms + excluded.session_ms`);

  // 失败维度累加（version/kind 已在 ingest 侧归一为非空串，保证 PK 无 NULL）
  const stBumpDailyFail = db.prepare(`
    INSERT INTO daily_fail (day, app_version, kind, failures)
    VALUES (@day, @appVersion, @kind, 1)
    ON CONFLICT(day, app_version, kind) DO UPDATE SET failures = failures + 1`);

  // 工作流维度累加（blueprint_id 已在 ingest 侧确保非空）。不相干列传 0，镜像 stBumpDaily。
  const stBumpDailyBlueprint = db.prepare(`
    INSERT INTO daily_blueprint (day, blueprint_id, runs_done, runs_failed, runs_halted,
                                 failures, active_ms, interruptions, in_tokens, out_tokens)
    VALUES (@day, @blueprintId, @runsDone, @runsFailed, @runsHalted,
            @failures, @activeMs, @interruptions, @inTokens, @outTokens)
    ON CONFLICT(day, blueprint_id) DO UPDATE SET
      runs_done = runs_done + excluded.runs_done,
      runs_failed = runs_failed + excluded.runs_failed,
      runs_halted = runs_halted + excluded.runs_halted,
      failures = failures + excluded.failures,
      active_ms = active_ms + excluded.active_ms,
      interruptions = interruptions + excluded.interruptions,
      in_tokens = in_tokens + excluded.in_tokens,
      out_tokens = out_tokens + excluded.out_tokens`);

  // ---- 夜间 job ----

  // 核对补算：从 events 重算事件派生列；heartbeats 永不出现在 SET 列表（铁律 2）。
  // SELECT 带 WHERE 是硬要求（SQLite 的 INSERT...SELECT...ON CONFLICT 无 WHERE 会有解析歧义）。
  const stRecomputeDaily = db.prepare(`
    INSERT INTO daily_user (day, install_id, user, host, sessions, session_ms,
                            runs_done, runs_failed, runs_halted, failures, run_active_ms,
                            in_tokens, out_tokens)
    SELECT day, install_id, MAX(user), MAX(host),
      SUM(CASE WHEN type = 'session_start' THEN 1 ELSE 0 END),
      CAST(SUM(CASE WHEN type = 'session_end' THEN ${msExpr('durationMs')} ELSE 0 END) AS INTEGER),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'done' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'failed' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'halted' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'failure_event' THEN 1 ELSE 0 END),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('activeMs')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'session_end' THEN ${msExpr('inputTokens')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'session_end' THEN ${msExpr('outputTokens')} ELSE 0 END) AS INTEGER)
    FROM events
    WHERE day >= @fromDay
    GROUP BY day, install_id
    ON CONFLICT(day, install_id) DO UPDATE SET
      sessions = excluded.sessions,
      session_ms = excluded.session_ms,
      runs_done = excluded.runs_done,
      runs_failed = excluded.runs_failed,
      runs_halted = excluded.runs_halted,
      failures = excluded.failures,
      run_active_ms = excluded.run_active_ms,
      in_tokens = excluded.in_tokens,
      out_tokens = excluded.out_tokens`);

  const stRecomputeDailyTool = db.prepare(`
    INSERT INTO daily_tool (day, tool, sessions, session_ms)
    SELECT day, ${TOOL_EXPR},
      SUM(CASE WHEN type = 'session_start' THEN 1 ELSE 0 END),
      CAST(SUM(CASE WHEN type = 'session_end' THEN ${msExpr('durationMs')} ELSE 0 END) AS INTEGER)
    FROM events
    WHERE day >= @fromDay AND type IN ('session_start', 'session_end')
    GROUP BY day, ${TOOL_EXPR}
    ON CONFLICT(day, tool) DO UPDATE SET
      sessions = excluded.sessions,
      session_ms = excluded.session_ms`);

  // 失败维度补算：version/kind 归一口径与 ingest 侧一致（缺失→'unknown'）
  const stRecomputeDailyFail = db.prepare(`
    INSERT INTO daily_fail (day, app_version, kind, failures)
    SELECT day, COALESCE(app_version, 'unknown'),
      COALESCE(NULLIF(CAST(json_extract(payload, '$.kind') AS TEXT), ''), 'unknown'),
      COUNT(*)
    FROM events
    WHERE day >= @fromDay AND type = 'failure_event'
    GROUP BY day, COALESCE(app_version, 'unknown'),
      COALESCE(NULLIF(CAST(json_extract(payload, '$.kind') AS TEXT), ''), 'unknown')
    ON CONFLICT(day, app_version, kind) DO UPDATE SET failures = excluded.failures`);

  // 工作流维度补算：bp_run_end（runs/active_ms/中断/token）+ 带 blueprintId 的 failure_event（failures）。
  // 只取 blueprintId 非空的行；数值列复用 msExpr 净化（正有限数才计入）。
  const stRecomputeDailyBlueprint = db.prepare(`
    INSERT INTO daily_blueprint (day, blueprint_id, runs_done, runs_failed, runs_halted,
                                 failures, active_ms, interruptions, in_tokens, out_tokens)
    SELECT day, CAST(json_extract(payload, '$.blueprintId') AS TEXT) bp,
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'done' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'failed' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'halted' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'failure_event' THEN 1 ELSE 0 END),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('activeMs')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('interruptions')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('inputTokens')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('outputTokens')} ELSE 0 END) AS INTEGER)
    FROM events
    WHERE day >= @fromDay AND type IN ('bp_run_end', 'failure_event')
      AND json_extract(payload, '$.blueprintId') IS NOT NULL
      AND CAST(json_extract(payload, '$.blueprintId') AS TEXT) != ''
    GROUP BY day, bp
    ON CONFLICT(day, blueprint_id) DO UPDATE SET
      runs_done = excluded.runs_done,
      runs_failed = excluded.runs_failed,
      runs_halted = excluded.runs_halted,
      failures = excluded.failures,
      active_ms = excluded.active_ms,
      interruptions = excluded.interruptions,
      in_tokens = excluded.in_tokens,
      out_tokens = excluded.out_tokens`);

  // 分块删避免长事务锁写路径（调用方循环至 changes = 0）
  const stDeleteEventsBefore = db.prepare(
    'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE day < ? LIMIT ?)');
  const stDeleteHbSeenBefore = db.prepare('DELETE FROM hb_seen WHERE day < ?');

  const stMetaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
  const stMetaSet = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  // ---- 读路径（stats）----
  // 用户去重键统一 user || '@' || host（同一人多个 DATA_ROOT 实例不重复计人）

  const stCountActiveUsersOn = db.prepare(
    "SELECT COUNT(DISTINCT user || '@' || host) c FROM daily_user WHERE day = ?");
  const stCountActiveUsersSince = db.prepare(
    "SELECT COUNT(DISTINCT user || '@' || host) c FROM daily_user WHERE day >= ?");
  const stCountOnline = db.prepare('SELECT COUNT(*) c FROM installs WHERE last_seen >= ?');
  const stTodayTotals = db.prepare(`
    SELECT COALESCE(SUM(sessions), 0) sessions, COALESCE(SUM(session_ms), 0) sessionMs,
           COALESCE(SUM(runs_done + runs_failed + runs_halted), 0) runs,
           COALESCE(SUM(failures), 0) failures,
           COALESCE(SUM(in_tokens), 0) inTokens, COALESCE(SUM(out_tokens), 0) outTokens
    FROM daily_user WHERE day = ?`);

  const stDauRange = db.prepare(`
    SELECT day, COUNT(DISTINCT user || '@' || host) dau,
           SUM(sessions) sessions, SUM(session_ms) sessionMs,
           SUM(in_tokens) inTokens, SUM(out_tokens) outTokens
    FROM daily_user WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`);
  const stDauUsers = db.prepare(
    "SELECT DISTINCT day, user || '@' || host uk FROM daily_user WHERE day BETWEEN ? AND ?");

  const stVersions = db.prepare(`
    SELECT COALESCE(app_version, 'unknown') version, COUNT(*) installs,
           COUNT(DISTINCT user || '@' || host) users
    FROM installs WHERE last_seen >= ? GROUP BY 1 ORDER BY installs DESC`);

  const stTools = db.prepare(`
    SELECT tool, SUM(sessions) sessions, SUM(session_ms) sessionMs
    FROM daily_tool WHERE day BETWEEN ? AND ? GROUP BY tool ORDER BY sessions DESC`);

  const stRuns = db.prepare(`
    SELECT day, SUM(runs_done) done, SUM(runs_failed) failed, SUM(runs_halted) halted,
           SUM(run_active_ms) activeMs
    FROM daily_user WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`);

  // kinds / byVersion 失败数走 daily_fail 小表（亚毫秒）；分母（总 run 数按版本）走
  // events 的 ix_runend_ver 覆盖索引；最近列表按 day DESC, server_ts DESC 走 ix_fail_recent 反向扫。
  const stFailureKinds = db.prepare(`
    SELECT kind, SUM(failures) n
    FROM daily_fail WHERE day BETWEEN ? AND ?
    GROUP BY kind ORDER BY n DESC`);
  const stFailuresByVersion = db.prepare(`
    SELECT app_version version, SUM(failures) n
    FROM daily_fail WHERE day BETWEEN ? AND ? GROUP BY 1`);
  const stRunEndsByVersion = db.prepare(`
    SELECT COALESCE(app_version, 'unknown') version, COUNT(*) n
    FROM events WHERE type = 'bp_run_end' AND day BETWEEN ? AND ? GROUP BY 1`);
  const stRecentFailures = db.prepare(`
    SELECT event_id eventId, server_ts serverTs, user, host, app_version appVersion, payload
    FROM events WHERE type = 'failure_event' AND day BETWEEN ? AND ?
    ORDER BY day DESC, server_ts DESC LIMIT ?`);

  const stInstalls = db.prepare(`
    SELECT install_id installId, user, host, platform, app_version appVersion, channel,
           first_seen firstSeen, last_seen lastSeen, live_sessions liveSessions
    FROM installs ORDER BY last_seen DESC`);

  // Top 用户：GROUP BY user@host，按指定 metric 排序。ORDER BY 列来自固定白名单（非用户输入），
  // 每个 metric 预编译一条（prepared statement 不能参数化 ORDER BY 列），杜绝注入。
  const TOP_USER_METRICS = {
    sessions: 'sessions', runs: 'runs', failures: 'failures', sessionMs: 'sessionMs', tokens: 'tokens',
  };
  const stTopUsers = {};
  for (const orderCol of Object.values(TOP_USER_METRICS)) {
    stTopUsers[orderCol] = db.prepare(`
      SELECT user, host,
        SUM(sessions) sessions, SUM(runs_done + runs_failed + runs_halted) runs,
        SUM(failures) failures, SUM(session_ms) sessionMs,
        SUM(in_tokens) inTokens, SUM(out_tokens) outTokens, SUM(in_tokens + out_tokens) tokens
      FROM daily_user WHERE day BETWEEN ? AND ?
      GROUP BY user || '@' || host ORDER BY ${orderCol} DESC, sessions DESC LIMIT ?`);
  }

  const stBlueprints = db.prepare(`
    SELECT blueprint_id blueprintId,
      SUM(runs_done) runsDone, SUM(runs_failed) runsFailed, SUM(runs_halted) runsHalted,
      SUM(failures) failures, SUM(active_ms) activeMs, SUM(interruptions) interruptions,
      SUM(in_tokens) inTokens, SUM(out_tokens) outTokens
    FROM daily_blueprint WHERE day BETWEEN ? AND ?
    GROUP BY blueprint_id
    ORDER BY SUM(runs_done + runs_failed + runs_halted) DESC`);

  return {
    // 写路径
    insertEvent(row) {
      return stInsertEvent.run({
        eventId: row.eventId, installId: row.installId, user: row.user, host: row.host,
        type: row.type, clientTs: row.clientTs ?? null, serverTs: row.serverTs, day: row.day,
        appVersion: row.appVersion ?? null, payload: row.payload ?? null,
      }).changes;
    },
    upsertInstall(p) {
      stUpsertInstall.run({
        installId: p.installId, user: p.user, host: p.host,
        platform: p.platform ?? null, appVersion: p.appVersion ?? null, channel: p.channel ?? null,
        nowIso: p.nowIso, liveSessions: p.liveSessions ?? null,
      });
    },
    markHbSeen(eventId, day) { return stMarkHbSeen.run(eventId, day).changes === 1; },
    bumpDaily(day, installId, user, host, d) {
      d = d || {};
      stBumpDaily.run({
        day, installId, user, host,
        heartbeats: d.heartbeats || 0, sessions: d.sessions || 0, sessionMs: d.sessionMs || 0,
        runsDone: d.runsDone || 0, runsFailed: d.runsFailed || 0, runsHalted: d.runsHalted || 0,
        failures: d.failures || 0, runActiveMs: d.runActiveMs || 0,
        inTokens: d.inTokens || 0, outTokens: d.outTokens || 0,
      });
    },
    bumpDailyTool(day, tool, sessions, sessionMs) {
      stBumpDailyTool.run({ day, tool, sessions: sessions || 0, sessionMs: sessionMs || 0 });
    },
    bumpDailyFail(day, appVersion, kind) {
      stBumpDailyFail.run({ day, appVersion, kind });
    },
    bumpDailyBlueprint(day, blueprintId, d) {
      d = d || {};
      stBumpDailyBlueprint.run({
        day, blueprintId,
        runsDone: d.runsDone || 0, runsFailed: d.runsFailed || 0, runsHalted: d.runsHalted || 0,
        failures: d.failures || 0, activeMs: d.activeMs || 0, interruptions: d.interruptions || 0,
        inTokens: d.inTokens || 0, outTokens: d.outTokens || 0,
      });
    },
    txIngest(fn) { return db.transaction(fn); },

    // 夜间 job
    recomputeDaily(fromDay) { return stRecomputeDaily.run({ fromDay }).changes; },
    recomputeDailyTool(fromDay) { return stRecomputeDailyTool.run({ fromDay }).changes; },
    recomputeDailyFail(fromDay) { return stRecomputeDailyFail.run({ fromDay }).changes; },
    recomputeDailyBlueprint(fromDay) { return stRecomputeDailyBlueprint.run({ fromDay }).changes; },
    deleteEventsBefore(cutoffDay, limit) { return stDeleteEventsBefore.run(cutoffDay, limit || 10000).changes; },
    deleteHbSeenBefore(cutoffDay) { return stDeleteHbSeenBefore.run(cutoffDay).changes; },
    incrementalVacuum() { db.pragma('incremental_vacuum'); },
    walCheckpointTruncate() { db.pragma('wal_checkpoint(TRUNCATE)'); },
    // 让查询计划器的统计随数据增长保鲜（partial 覆盖索引的选取依赖统计）；夜间调用，代价小
    optimize() { db.pragma('optimize'); },
    metaGet(key) { const r = stMetaGet.get(key); return r ? r.value : null; },
    metaSet(key, value) { stMetaSet.run(key, String(value)); },

    // 读路径
    qCountActiveUsersOn(day) { return stCountActiveUsersOn.get(day).c; },
    qCountActiveUsersSince(fromDay) { return stCountActiveUsersSince.get(fromDay).c; },
    qCountOnline(sinceIso) { return stCountOnline.get(sinceIso).c; },
    qTodayTotals(day) { return stTodayTotals.get(day); },
    qDauRange(from, to) { return stDauRange.all(from, to); },
    qDauUsers(from, to) { return stDauUsers.all(from, to); },
    qVersions(sinceIso) { return stVersions.all(sinceIso); },
    qTools(from, to) { return stTools.all(from, to); },
    qRuns(from, to) { return stRuns.all(from, to); },
    qFailureKinds(from, to) { return stFailureKinds.all(from, to); },
    qFailuresByVersion(from, to) { return stFailuresByVersion.all(from, to); },
    qRunEndsByVersion(from, to) { return stRunEndsByVersion.all(from, to); },
    qRecentFailures(from, to, limit) { return stRecentFailures.all(from, to, limit || 100); },
    qInstalls() { return stInstalls.all(); },
    // metric 必须是白名单键（stats 侧已校验）；未知则回退 sessions
    qTopUsers(from, to, metric, limit) {
      const col = TOP_USER_METRICS[metric] || 'sessions';
      return stTopUsers[col].all(from, to, Math.min(Math.max(1, limit || 10), 100));
    },
    qBlueprints(from, to) { return stBlueprints.all(from, to); },
    // 供 stats 校验 metric 合法性
    topUserMetrics: Object.keys(TOP_USER_METRICS),
  };
}

// 打开（或创建）数据库：PRAGMA 时序敏感——auto_vacuum 只对未建表的空库生效，必须先于 DDL
function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  if (db.pragma('user_version', { simple: true }) === 0) {
    db.pragma('auto_vacuum = INCREMENTAL');
  }
  db.pragma('journal_mode = WAL');      // 持久于库文件，重复设置无害
  db.pragma('synchronous = NORMAL');    // 连接级，每次打开都要设
  db.pragma('busy_timeout = 5000');     // 备份/bench 工具旁挂时兜底
  runMigrations(db);
  const dao = makeDao(db);
  return { db, dao, close() { try { db.close(); } catch (_) { /* 已关闭则忽略 */ } } };
}

module.exports = { openDb };

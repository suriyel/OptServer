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

// 事件「真实发生时刻」SQL 片段（recency / 夜间重算 / 回填共用；与 ingest.js 的 eventAtOf 同口径）。
//
// 取 client_ts 而非 server_ts：客户端有 spool 断网缓冲，用接收时刻会把断网 3 天后重连补发的
// 活动记成「今天」——过报新鲜度，恰好是 recency 最该避免的失效方向。
// 单向未来阀：只有 client_ts **晚于** server_ts 才可能是时钟走快（物理不可能）；client_ts 比
// server_ts 早很多是**正常**的（那就是补发），拿"差值大"当异常判据会把断网用户的真实活跃时刻全删掉。
// strftime 归一为 UTC ISO：保证字典序 = 时间序（MAX 才成立），也吃得下带偏移的老格式；
// 不可解析时 strftime 返回 NULL，COALESCE 回落 server_ts。
// 与 JS 侧的逐例一致性有测试守着（__tests__/recency.test.js）。
const CLOCK_SKEW_TOLERANCE_SEC = 300;
const EVENT_AT_EXPR =
  "COALESCE(CASE WHEN strftime('%s', client_ts) IS NOT NULL"
  + " AND CAST(strftime('%s', client_ts) AS INTEGER)"
  + ' <= CAST(' + "strftime('%s', server_ts)" + ' AS INTEGER) + ' + CLOCK_SKEW_TOLERANCE_SEC
  + " THEN strftime('%Y-%m-%dT%H:%M:%fZ', client_ts) END, server_ts)";

// 参与 recency 的事件类型（实质使用）。心跳不落 events 故天然不在内；
// instance_online（只为确保当日行存在）与 update_apply（安装面，非使用）刻意排除。
// 时段分布（daily_hour）复用同一份名单——「使用」的定义只该有一个。
const RECENCY_TYPES = ['session_start', 'session_end', 'bp_run_end', 'failure_event'];
const RECENCY_TYPES_SQL = RECENCY_TYPES.map((t) => `'${t}'`).join(', ');

// ---- 时段分布（daily_hour）的 SQL 片段；与 ingest.js 的 hourBucketOf 同口径 ----
// day/hour 同源于 client_ts 并转**服务器本地**时区（client_ts 是 UTC，客户端从不上报偏移，
// 见 docs/CLIENT-HANDOFF.md §3；所以只能按部署机时区解读——TZ 一旦定下不可改，
// 改了重跑回填会与增量积累的行对不上，见 DEPLOYMENT §4.1）。
const CLIENT_DAY_EXPR = "strftime('%Y-%m-%d', client_ts, 'localtime')";
const CLIENT_HOUR_EXPR = "CAST(strftime('%H', client_ts, 'localtime') AS INTEGER)";
// 入桶资格：能解析 **且** 未越过单向未来阀。不合格的**直接丢弃并计数**，不像 recency 那样
// 回落 server_ts——recency 有个值比没有强，而时段分布里一个错误的小时会直接污染分布。
const HOUR_ELIGIBLE_EXPR =
  "strftime('%s', client_ts) IS NOT NULL AND CAST(strftime('%s', client_ts) AS INTEGER)"
  + " <= CAST(strftime('%s', server_ts) AS INTEGER) + " + CLOCK_SKEW_TOLERANCE_SEC;

// 时钟异常丢弃计数的 meta 键（由 /v1/stats/hours 带出，热力图面板脚注显示——
// 不暴露的话这个丢弃是静默的，没人会发现口径在漏数据）
const META_HOUR_DROPPED = 'hour_dropped_clock_skew';

// 未知 type 事件计数的 meta 键（由 /v1/stats/overview 带出，总览页仅在 >0 时出一张卡）。
// ★ 同上那条理由，但它防的是**跨仓漂移**：客户端加了新事件类型而这边的 KNOWN_TYPES 没跟上时，
//   事件会照常落 events 原始表、照常计 accepted，却**不做任何聚合** ⇒ 看板上零样本、
//   零报错、零日志，和「客户端压根没发」长得一模一样。计出来才有人会发现。
const META_UNKNOWN_TYPE = 'unknown_type_events';

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

// v2：登录鉴权。accounts 是「登录账号」（区别于遥测表 daily_user/installs 里被观测的应用用户）。
// pass_hash/salt 为 crypto.scryptSync 派生（见 lib/auth.js）；role ∈ {admin,user}。
// ux_accounts_admin 是「至多一个 admin」的库级硬约束——partial unique index 只对 role='admin'
// 子集唯一，任何路径都造不出第二个管理员（应用层再兜一层：新建用户恒 role='user'）。
// sessions 为登录会话：token(随机)→username，惰性按 expires_at 过期（resolveAccount 命中过期即删）。
const DDL_V2 = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT
);
CREATE UNIQUE INDEX ux_accounts_admin ON accounts(role) WHERE role = 'admin';

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT,
  expires_at TEXT
);
CREATE INDEX ix_sessions_expires ON sessions(expires_at);
`;

// v3：最近失败列表并入 update_apply 后的索引补齐。stRecentFailures 原本靠 ix_fail_recent
// （partial，WHERE type='failure_event'）反向扫 + LIMIT；并进 update_apply 分支后该 partial
// 索引盖不住 OR 的另一半，SQLite 直接弃用它退化成按 day 扫全表再排序（EXPLAIN 实测）。
// 解法是给 update_apply 配一个对称的 partial 索引，查询侧改写成 UNION ALL 让两分支各走各的。
const DDL_V3 = `
CREATE INDEX ix_update_recent ON events(day, server_ts) WHERE type = 'update_apply';
`;

// v4：recency（「上次实质使用」）。**加列不加表**——SQLite 的 ADD COLUMN（可空、无 DEFAULT、
// 无约束）是纯元数据操作，不重写表、O(1)，几百万行也是毫秒级，故随启动自动迁移不会碰
// systemd 的 TimeoutStartSec。存量行 last_at 为 NULL，由 `npm run backfill` 单独回填。
//
// 口径（设计留档见 docs/TIME-DIMENSION-PLAN.md P2）：只认**实质使用**事件（会话/run/失败），
// 心跳与 instance_online 一律不算。反例是 installs.last_seen——它含心跳，客户端每 5min 跳一次，
// 装了挂着从不用的人永远显示「5 分钟前」，照那个口径看板会显示全员活跃，恰好把要看的东西盖住。
//
// 附带一个索引：recency 查询要按 (user, host) 分组取 MAX(last_at)，而 daily_user 主键是
// (day, install_id)，无索引时是全表扫 + 临时 B 树。实测 73 万行（千人×两年）**413ms**——
// 这不是"多年后的尾巴"，是当下就有的回归，而用户页 60s 自动刷新会反复付这笔钱。
// (user, host, last_at) 覆盖索引把它压到 87ms；写入代价实测 +1.45µs/次 upsert
// （8 万事件/日 ≈ 每天多 0.12 秒，可忽略）。
// ⚠ 索引只在 GROUP BY 写成 (user, host) 时才生效——写成 user||'@'||host 那个拼接表达式
// SQLite 匹配不上索引，仍走 TEMP B-TREE（实测 356ms）。见 stUserRecency 的注释。
const DDL_V4 = `
ALTER TABLE daily_user ADD COLUMN last_at TEXT;
ALTER TABLE daily_blueprint ADD COLUMN last_at TEXT;
CREATE INDEX ix_daily_user_recency ON daily_user(user, host, last_at);
`;

// v5：使用时段分布（作息）。**day 与 hour 同源于 client_ts**（转服务器本地时区），表内自洽。
//
// 为什么不用 server_ts：客户端有 spool 断网缓冲，用接收时刻分桶会把断网期间的活动
// 全堆到重连那一刻，凭空造出假高峰——图会看起来很有信息量而实际是假的。
// 为什么 day 也必须同源：若 day 用 server 而 hour 用 client，一个「昨天 23:00 发生、
// 今早 09:00 补发」的事件会记成 day=今天/hour=23——今天这一行冒出一根 23 点的柱子，
// 而今天 23 点还没到；24×7 热力图里跨午夜的事件还会落进错的格子。
//
// ⚠ 代价（务必写进文档）：daily_hour.day 与 daily_*.day 是**两套口径**，两表永不可 join /
// 对账。且全局行（blueprint_id='')**不等于**各工作流行之和——会话类事件没有 blueprintId，
// 只进全局行。以后一定有人拿这两个对账然后报 bug。
//
// 保留策略：永久（它不是 events，不进 90 天清理）。行数 = 天 × 24 × (1 + 工作流数)。
const DDL_V5 = `
CREATE TABLE daily_hour (
  day TEXT, hour INTEGER, blueprint_id TEXT,
  events INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0, runs INTEGER DEFAULT 0,
  PRIMARY KEY (day, hour, blueprint_id)
);
`;

const MIGRATIONS = [
  { version: 1, sql: DDL_V1 },
  { version: 2, sql: DDL_V2 },
  { version: 3, sql: DDL_V3 },
  { version: 4, sql: DDL_V4 },
  { version: 5, sql: DDL_V5 },
  // 未来 v6 在此追加 { version: 6, sql: ... }
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
                            in_tokens, out_tokens, last_at)
    VALUES (@day, @installId, @user, @host, @heartbeats, @sessions, @sessionMs,
            @runsDone, @runsFailed, @runsHalted, @failures, @runActiveMs,
            @inTokens, @outTokens, @lastAt)
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
      out_tokens = out_tokens + excluded.out_tokens,
      -- last_at 取 MAX 不累加；非实质事件传 NULL，绝不覆盖已有值（心跳把它冲掉就前功尽弃）
      last_at = CASE WHEN excluded.last_at IS NOT NULL
                      AND (last_at IS NULL OR excluded.last_at > last_at)
                     THEN excluded.last_at ELSE last_at END`);

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
                                 failures, active_ms, interruptions, in_tokens, out_tokens, last_at)
    VALUES (@day, @blueprintId, @runsDone, @runsFailed, @runsHalted,
            @failures, @activeMs, @interruptions, @inTokens, @outTokens, @lastAt)
    ON CONFLICT(day, blueprint_id) DO UPDATE SET
      runs_done = runs_done + excluded.runs_done,
      runs_failed = runs_failed + excluded.runs_failed,
      runs_halted = runs_halted + excluded.runs_halted,
      failures = failures + excluded.failures,
      active_ms = active_ms + excluded.active_ms,
      interruptions = interruptions + excluded.interruptions,
      in_tokens = in_tokens + excluded.in_tokens,
      out_tokens = out_tokens + excluded.out_tokens,
      last_at = CASE WHEN excluded.last_at IS NOT NULL
                      AND (last_at IS NULL OR excluded.last_at > last_at)
                     THEN excluded.last_at ELSE last_at END`);

  // 时段分桶累加。blueprint_id='' 为全局行——它**不等于**各工作流行之和（会话类事件没有
  // blueprintId，只进全局行），文档与 UI 都要写明。
  const stBumpDailyHour = db.prepare(`
    INSERT INTO daily_hour (day, hour, blueprint_id, events, sessions, runs)
    VALUES (@day, @hour, @blueprintId, @events, @sessions, @runs)
    ON CONFLICT(day, hour, blueprint_id) DO UPDATE SET
      events = events + excluded.events,
      sessions = sessions + excluded.sessions,
      runs = runs + excluded.runs`);

  // ---- 夜间 job ----

  // 核对补算：从 events 重算事件派生列；heartbeats 永不出现在 SET 列表（铁律 2）。
  // SELECT 带 WHERE 是硬要求（SQLite 的 INSERT...SELECT...ON CONFLICT 无 WHERE 会有解析歧义）。
  const stRecomputeDaily = db.prepare(`
    INSERT INTO daily_user (day, install_id, user, host, sessions, session_ms,
                            runs_done, runs_failed, runs_halted, failures, run_active_ms,
                            in_tokens, out_tokens, last_at)
    SELECT day, install_id, MAX(user), MAX(host),
      SUM(CASE WHEN type = 'session_start' THEN 1 ELSE 0 END),
      CAST(SUM(CASE WHEN type = 'session_end' THEN ${msExpr('durationMs')} ELSE 0 END) AS INTEGER),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'done' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'failed' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'halted' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'failure_event' THEN 1 ELSE 0 END),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('activeMs')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'session_end' THEN ${msExpr('inputTokens')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'session_end' THEN ${msExpr('outputTokens')} ELSE 0 END) AS INTEGER),
      -- recency 只取实质使用类型；当日若只有 instance_online/update_apply，MAX 得 NULL，
      -- 覆盖回 NULL 是正确的（补算窗内 events 尚未被清理，这就是权威值）
      MAX(CASE WHEN type IN (${RECENCY_TYPES_SQL}) THEN ${EVENT_AT_EXPR} END)
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
      out_tokens = excluded.out_tokens,
      last_at = excluded.last_at`);

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
                                 failures, active_ms, interruptions, in_tokens, out_tokens, last_at)
    SELECT day, CAST(json_extract(payload, '$.blueprintId') AS TEXT) bp,
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'done' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'failed' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'halted' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'failure_event' THEN 1 ELSE 0 END),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('activeMs')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('interruptions')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('inputTokens')} ELSE 0 END) AS INTEGER),
      CAST(SUM(CASE WHEN type = 'bp_run_end' THEN ${msExpr('outputTokens')} ELSE 0 END) AS INTEGER),
      -- WHERE 已把类型限死在 bp_run_end/failure_event（都是实质使用），故无需再 CASE 过滤
      MAX(${EVENT_AT_EXPR})
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
      out_tokens = excluded.out_tokens,
      last_at = excluded.last_at`);

  // 时段分布补算。与其它 recompute 不同，它是 **DELETE + INSERT** 而非 upsert：
  // 目标行的键（client 本地日/时）与过滤列（events.day = server 接收日）不是同一套口径，
  // upsert 无法表达"该窗口内重建"。
  //
  // 正确性依赖一条不变式：未来阀保证 client_ts ≤ server_ts + 5min，故 **client 日 ≤ server 日**。
  // 于是「client 日 ≥ fromDay」的事件必然满足「server 日 ≥ fromDay」——用 events.day 过滤
  // （走 ix_events_day）是个**超集**，绝不会漏。多出来的是 spool 迟到件（server 日在窗内、
  // client 日更早），用第二个条件滤掉，它们对应的旧行不在 DELETE 范围内、保持 ingest 写的值，
  // 与其它 recompute「只修窗口内的行」的语义一致。
  const stClearDailyHourFrom = db.prepare('DELETE FROM daily_hour WHERE day >= ?');
  const stRecomputeDailyHourGlobal = db.prepare(`
    INSERT INTO daily_hour (day, hour, blueprint_id, events, sessions, runs)
    SELECT ${CLIENT_DAY_EXPR} cd, ${CLIENT_HOUR_EXPR} ch, '',
      COUNT(*),
      SUM(CASE WHEN type = 'session_start' THEN 1 ELSE 0 END),
      SUM(CASE WHEN type = 'bp_run_end' THEN 1 ELSE 0 END)
    FROM events
    WHERE day >= @fromDay AND type IN (${RECENCY_TYPES_SQL})
      AND ${HOUR_ELIGIBLE_EXPR} AND ${CLIENT_DAY_EXPR} >= @fromDay
    GROUP BY cd, ch`);
  const stRecomputeDailyHourBlueprint = db.prepare(`
    INSERT INTO daily_hour (day, hour, blueprint_id, events, sessions, runs)
    SELECT ${CLIENT_DAY_EXPR} cd, ${CLIENT_HOUR_EXPR} ch,
      CAST(json_extract(payload, '$.blueprintId') AS TEXT) bp,
      COUNT(*), 0,
      SUM(CASE WHEN type = 'bp_run_end' THEN 1 ELSE 0 END)
    FROM events
    WHERE day >= @fromDay AND type IN ('bp_run_end', 'failure_event')
      AND ${HOUR_ELIGIBLE_EXPR} AND ${CLIENT_DAY_EXPR} >= @fromDay
      AND json_extract(payload, '$.blueprintId') IS NOT NULL
      AND CAST(json_extract(payload, '$.blueprintId') AS TEXT) != ''
    GROUP BY cd, ch, bp`);

  // 分块删避免长事务锁写路径（调用方循环至 changes = 0）
  const stDeleteEventsBefore = db.prepare(
    'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE day < ? LIMIT ?)');
  const stDeleteHbSeenBefore = db.prepare('DELETE FROM hb_seen WHERE day < ?');

  // meta.value 是 TEXT 列，两层 CAST 都不能省（实测踩到，写成过 "1724.0"）：
  // · 绑定值必须 CAST(? AS INTEGER)——better-sqlite3 把 JS number 绑成 **REAL**，
  //   INTEGER + REAL 在 SQLite 里是 REAL，外层再怎么转都带小数点；
  // · 结果必须 CAST(... AS TEXT)——否则数值直接落进 TEXT 列，格式随类型漂移。
  // 按 key 累加的通用计数器（hour_dropped_clock_skew / unknown_type_events 共用这一条 ——
  // 各备一条一模一样的 prepare 只是多一处会漂的地方）。
  const stBumpCounter = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(CAST(value AS INTEGER) + CAST(? AS INTEGER) AS TEXT)`);

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
  // events 的 ix_runend_ver 覆盖索引；最近列表按 day DESC, server_ts DESC 反向扫两个 partial
  // 索引（ix_fail_recent / ix_update_recent）后归并，见 stRecentFailures。
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
  // 最近失败列表 = 业务失败(failure_event) + 装失败(update_apply 且 ok:false)。
  // 必须写成 UNION ALL 而非一条 WHERE ... OR ...：OR 会让两个 partial 索引同时失效
  // （SQLite 弃用 ix_fail_recent，退化成 ix_events_day 扫全窗口 + TEMP B-TREE 排序，
  // 90 天窗口下每行 events 都要回表取 type——bench 的 'failures recent 100' 20ms 线会破）。
  // 拆开后两分支各自命中自己的 partial 索引、各自反向扫 + LIMIT，外层只归并 ≤2×limit 行。
  // 注：day 必须出现在 SELECT 列表里——复合查询的外层 ORDER BY 只能引用输出列名，
  //     且外层要用别名 serverTs（非 server_ts）。多出的 day 列消费方不透传，无害。
  const RECENT_FAIL_COLS =
    'event_id eventId, server_ts serverTs, user, host, app_version appVersion, type, day, payload';
  const stRecentFailures = db.prepare(`
    SELECT * FROM (
      SELECT ${RECENT_FAIL_COLS} FROM events
      WHERE type = 'failure_event' AND day BETWEEN ? AND ?
      ORDER BY day DESC, server_ts DESC LIMIT ?
    )
    UNION ALL
    SELECT * FROM (
      SELECT ${RECENT_FAIL_COLS} FROM events
      WHERE type = 'update_apply' AND json_extract(payload, '$.ok') = 0 AND day BETWEEN ? AND ?
      ORDER BY day DESC, server_ts DESC LIMIT ?
    )
    ORDER BY day DESC, serverTs DESC LIMIT ?`);

  const stInstalls = db.prepare(`
    SELECT install_id installId, user, host, platform, app_version appVersion, channel,
           first_seen firstSeen, last_seen lastSeen, live_sessions liveSessions
    FROM installs ORDER BY last_seen DESC`);

  // 原始事件按类型回读（**只读**）。本服务自己的 stats 一律走聚合表，从不看原始表 ——
  // 这条是给**跨仓闭环用例**用的：采集端那边要验「我发出去的 payload，落到你库里之后
  // 形态没被改写」，而那件事只有原始表看得见（聚合表把 payload 丢掉了）。
  // ★ payload 原样回字符串，DAO 不猜内容 —— 解析口径归调用方，免得两边各解一次而分歧。
  // ★ 不建索引：这是排障/对拍面，不在任何热路径上（ix_events_day 已够）。
  const stEventsByType = db.prepare(`
    SELECT event_id eventId, install_id installId, user, host, type,
           client_ts clientTs, server_ts serverTs, day, app_version appVersion, payload
    FROM events WHERE type = ? ORDER BY id DESC LIMIT ?`);

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

  // 全量用户（导出用）：SELECT 列表与 stTopUsers 一致，但无 LIMIT、固定按 sessions 降序，
  // 供 /v1/export/users 导出范围内全部用户 + 全部指标列（不受 Top N 截断）。
  const stUsersAll = db.prepare(`
    SELECT user, host,
      SUM(sessions) sessions, SUM(runs_done + runs_failed + runs_halted) runs,
      SUM(failures) failures, SUM(session_ms) sessionMs,
      SUM(in_tokens) inTokens, SUM(out_tokens) outTokens, SUM(in_tokens + out_tokens) tokens
    FROM daily_user WHERE day BETWEEN ? AND ?
    GROUP BY user || '@' || host ORDER BY sessions DESC`);

  const stBlueprints = db.prepare(`
    SELECT blueprint_id blueprintId,
      SUM(runs_done) runsDone, SUM(runs_failed) runsFailed, SUM(runs_halted) runsHalted,
      SUM(failures) failures, SUM(active_ms) activeMs, SUM(interruptions) interruptions,
      SUM(in_tokens) inTokens, SUM(out_tokens) outTokens
    FROM daily_blueprint WHERE day BETWEEN ? AND ?
    GROUP BY blueprint_id
    ORDER BY SUM(runs_done + runs_failed + runs_halted) DESC`);

  // ---- recency（不带 range 全表）----
  // **必须不受 range 约束**：一个 30 天没跑的工作流在「近 30 天」聚合里压根没有行，
  // 给主表加「沉默天数」列也渲染不出来——「谁不用了」这个问题本质上回答不了。
  // daily_blueprint 一年约 1 万行（天×工作流数），全表 GROUP BY 毫秒级。
  const stBlueprintRecency = db.prepare(`
    SELECT blueprint_id blueprintId, MAX(last_at) lastAt,
           SUM(runs_done + runs_failed + runs_halted) lifetimeRuns
    FROM daily_blueprint GROUP BY blueprint_id`);

  // 用户 recency（全表）：**只用于沉默排行与 CSV 导出**——两者都需要「所有人」才排得出名次。
  // 普通 metric 路径只需要返回的那 ≤100 行的 recency，走下面的 stUserRecencyOne 点查
  // （实测 Top10 点查 0.02ms vs 全表 87ms，差 4000 倍；用户页 60s 自动刷新，这笔账必须省）。
  //
  // ⚠ GROUP BY 必须写成 (user, host) 而**不是** user||'@'||host：拼接表达式匹配不上
  // ix_daily_user_recency，SQLite 会退化成 TEMP B-TREE（73 万行实测 356ms vs 87ms）。
  // 分组语义也更严谨——拼接键存在碰撞（'a@b'+'c' 与 'a'+'b@c' 同键），分列不会。
  // 只有心跳的用户（daily 行存在但 last_at 全 NULL）得 lastAt=NULL，语义正是「装了从没用过」。
  const stUserRecency = db.prepare(`
    SELECT user, host, MAX(last_at) lastAt
    FROM daily_user GROUP BY user, host`);
  const stUserRecencyOne = db.prepare(
    'SELECT MAX(last_at) lastAt FROM daily_user WHERE user = ? AND host = ?');

  // ---- 回填（scripts/backfill.js；逐日一个事务，幂等可重跑）----
  // 与夜间重算共用 EVENT_AT_EXPR/RECENCY_TYPES，保证回填值与增量积累值逐位一致。
  // 只 UPDATE last_at 一列：其余列是历史权威，回填绝不能碰。
  const stBackfillUserDay = db.prepare(`
    UPDATE daily_user SET last_at = (
      SELECT MAX(${EVENT_AT_EXPR}) FROM events e
      WHERE e.day = daily_user.day AND e.install_id = daily_user.install_id
        AND e.type IN (${RECENCY_TYPES_SQL}))
    WHERE day = ?`);
  const stBackfillBlueprintDay = db.prepare(`
    UPDATE daily_blueprint SET last_at = (
      SELECT MAX(${EVENT_AT_EXPR}) FROM events e
      WHERE e.day = daily_blueprint.day
        AND CAST(json_extract(e.payload, '$.blueprintId') AS TEXT) = daily_blueprint.blueprint_id
        AND e.type IN ('bp_run_end', 'failure_event'))
    WHERE day = ?`);
  // events 已被 90 天清理的更早日子：只能用当日 day 兜底成**日精度**（12:00 占位，避免时区边界
  // 把它推到前后一天）。仅填 NULL 行，不覆盖任何已算出的精确值。
  const stBackfillUserFallback = db.prepare(
    "UPDATE daily_user SET last_at = day || 'T12:00:00.000Z' WHERE last_at IS NULL AND day < ? AND (sessions > 0 OR runs_done + runs_failed + runs_halted > 0 OR failures > 0)");
  const stBackfillBlueprintFallback = db.prepare(
    "UPDATE daily_blueprint SET last_at = day || 'T12:00:00.000Z' WHERE last_at IS NULL AND day < ?");
  // 回填进度/校验用
  const stDistinctDaysWithEvents = db.prepare(
    'SELECT DISTINCT day FROM events WHERE day >= ? ORDER BY day');
  const stCountNullLastAt = db.prepare(`
    SELECT (SELECT COUNT(*) FROM daily_user WHERE last_at IS NULL) users,
           (SELECT COUNT(*) FROM daily_blueprint WHERE last_at IS NULL) blueprints`);

  // ---- 时段分布查询（作息热力图）----
  // 按 (day, hour) 返回；折成 周几×小时 交给 stats 层（≤ 窗口天数 × 24 行，几百行量级）。
  // 固定窗口（默认近 30 天）而非跟随顶栏 range：7 天档下每个「周几×小时」格子只有 1 个样本，
  // 那不是作息规律是随机噪声，而图看起来很有信息量——比没有图更糟。
  const stHours = db.prepare(`
    SELECT day, hour, SUM(events) events, SUM(sessions) sessions, SUM(runs) runs
    FROM daily_hour WHERE blueprint_id = @bp AND day BETWEEN @from AND @to
    GROUP BY day, hour ORDER BY day, hour`);

  // ---- 单实体逐日序列（详情面板下钻）----
  // 只返回有行的日子，补零交 stats 层（与 /stats/runs、/stats/dau 同做法）。
  // daily_blueprint 主键 (day, blueprint_id) 以 day 先导：范围内按天扫 + 过滤 blueprint_id，
  // 90 天 × 工作流数 ≈ 数千行，无需为下钻单开索引（P1 不动 schema）。
  const stBlueprintSeries = db.prepare(`
    SELECT day, runs_done runsDone, runs_failed runsFailed, runs_halted runsHalted,
           failures, active_ms activeMs, interruptions,
           in_tokens inTokens, out_tokens outTokens
    FROM daily_blueprint WHERE blueprint_id = ? AND day BETWEEN ? AND ? ORDER BY day`);

  // 用户逐日：必须 GROUP BY day——同一 user@host 可能有多个 install_id（多 DATA_ROOT 实例），
  // 与 stTopUsers 的 user||'@'||host 去重口径保持一致。
  // daily_user 主键 (day, install_id)：按 user/host 过滤要扫范围内全部行（90 天千人 ≈ 9 万行、
  // 十毫秒级）。这是按需下钻、非页面首屏，P1 不为它加索引。
  const stUserSeries = db.prepare(`
    SELECT day, SUM(sessions) sessions, SUM(session_ms) sessionMs,
           SUM(runs_done) runsDone, SUM(runs_failed) runsFailed, SUM(runs_halted) runsHalted,
           SUM(failures) failures, SUM(run_active_ms) activeMs,
           SUM(in_tokens) inTokens, SUM(out_tokens) outTokens
    FROM daily_user WHERE user = ? AND host = ? AND day BETWEEN ? AND ?
    GROUP BY day ORDER BY day`);

  // 实时：直查 events 近窗口，按 UTC 分钟(server_ts 前 16 位)分桶。day 先导过滤走 ix_events_day
  // 缩到近 2 天，再按 server_ts 精确切窗；token 口径与 daily 一致(仅 session_end，防双计)。
  // activeUsers = 该分钟去重 user@host（活跃，非在线——心跳不落 events）。只返回非空桶，补零交前端。
  const stRealtime = db.prepare(`
    SELECT substr(server_ts, 1, 16) min,
      COUNT(*) events,
      SUM(CASE WHEN type = 'session_start' THEN 1 ELSE 0 END) sessions,
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'done'   THEN 1 ELSE 0 END) runsDone,
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'failed' THEN 1 ELSE 0 END) runsFailed,
      SUM(CASE WHEN type = 'bp_run_end' AND json_extract(payload, '$.status') = 'halted' THEN 1 ELSE 0 END) runsHalted,
      SUM(CASE WHEN type = 'failure_event' THEN 1 ELSE 0 END) failures,
      CAST(SUM(CASE WHEN type = 'session_end' THEN ${msExpr('inputTokens')} + ${msExpr('outputTokens')} ELSE 0 END) AS INTEGER) tokens,
      COUNT(DISTINCT user || '@' || host) activeUsers
    FROM events
    WHERE day >= @cutoffDay AND server_ts >= @cutoffIso
    GROUP BY min ORDER BY min`);

  // ---- 鉴权（accounts / sessions）----
  const stAccountByUsername = db.prepare(
    'SELECT id, username, pass_hash passHash, salt, role, created_at createdAt FROM accounts WHERE username = ?');
  const stInsertAccount = db.prepare(
    'INSERT INTO accounts (username, pass_hash, salt, role, created_at) VALUES (@username, @passHash, @salt, @role, @createdAt)');
  const stListAccounts = db.prepare(
    'SELECT id, username, role, created_at createdAt FROM accounts ORDER BY (role = \'admin\') DESC, username');
  const stDeleteAccount = db.prepare('DELETE FROM accounts WHERE username = ?');
  const stUpdateAccountPassword = db.prepare(
    'UPDATE accounts SET pass_hash = @passHash, salt = @salt WHERE username = @username');
  const stCountAdmins = db.prepare("SELECT COUNT(*) c FROM accounts WHERE role = 'admin'");

  const stInsertSession = db.prepare(
    'INSERT INTO sessions (token, username, created_at, expires_at) VALUES (@token, @username, @createdAt, @expiresAt)');
  const stSession = db.prepare('SELECT token, username, created_at createdAt, expires_at expiresAt FROM sessions WHERE token = ?');
  const stDeleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
  const stDeleteSessionsByUser = db.prepare('DELETE FROM sessions WHERE username = ?');
  const stDeleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

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
        lastAt: d.lastAt || null, // 非实质使用事件传 null，不触碰已有 last_at
      });
    },
    bumpDailyTool(day, tool, sessions, sessionMs) {
      stBumpDailyTool.run({ day, tool, sessions: sessions || 0, sessionMs: sessionMs || 0 });
    },
    bumpDailyFail(day, appVersion, kind) {
      stBumpDailyFail.run({ day, appVersion, kind });
    },
    // 时段分桶：day/hour 由 ingest 侧从 client_ts 算好传入（与 SQL 侧同口径，有对拍用例）
    bumpDailyHour(day, hour, blueprintId, d) {
      d = d || {};
      stBumpDailyHour.run({ day, hour, blueprintId: blueprintId || '',
        events: d.events || 0, sessions: d.sessions || 0, runs: d.runs || 0 });
    },
    // 时钟异常导致的丢弃计数（累加进 meta；/v1/stats/hours 带出，避免静默漏数据）
    bumpHourDropped(n) {
      if (n > 0) stBumpCounter.run(META_HOUR_DROPPED, String(n), n);
    },
    qHourDropped() {
      const r = stMetaGet.get(META_HOUR_DROPPED);
      return r ? Number(r.value) || 0 : 0;
    },
    bumpUnknownTypes(n) {
      if (n > 0) stBumpCounter.run(META_UNKNOWN_TYPE, String(n), n);
    },
    qUnknownTypes() {
      const r = stMetaGet.get(META_UNKNOWN_TYPE);
      return r ? Number(r.value) || 0 : 0;
    },
    bumpDailyBlueprint(day, blueprintId, d) {
      d = d || {};
      stBumpDailyBlueprint.run({
        day, blueprintId,
        runsDone: d.runsDone || 0, runsFailed: d.runsFailed || 0, runsHalted: d.runsHalted || 0,
        failures: d.failures || 0, activeMs: d.activeMs || 0, interruptions: d.interruptions || 0,
        inTokens: d.inTokens || 0, outTokens: d.outTokens || 0,
        lastAt: d.lastAt || null,
      });
    },
    txIngest(fn) { return db.transaction(fn); },

    // 夜间 job
    recomputeDaily(fromDay) { return stRecomputeDaily.run({ fromDay }).changes; },
    recomputeDailyTool(fromDay) { return stRecomputeDailyTool.run({ fromDay }).changes; },
    recomputeDailyFail(fromDay) { return stRecomputeDailyFail.run({ fromDay }).changes; },
    recomputeDailyBlueprint(fromDay) { return stRecomputeDailyBlueprint.run({ fromDay }).changes; },
    // 时段分布：窗口内先清后建（键与过滤列不同源，upsert 表达不了「窗口内重建」）
    recomputeDailyHour(fromDay) {
      return db.transaction((f) => {
        stClearDailyHourFrom.run(f);
        return stRecomputeDailyHourGlobal.run({ fromDay: f }).changes
          + stRecomputeDailyHourBlueprint.run({ fromDay: f }).changes;
      })(fromDay);
    },
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
    // 两个 UNION ALL 分支各取 limit 行，归并后再截 limit（故绑定 7 个参数）
    qRecentFailures(from, to, limit) {
      const n = limit || 100;
      return stRecentFailures.all(from, to, n, from, to, n, n);
    },
    qInstalls() { return stInstalls.all(); },
    // 原始事件按类型回读（只读；见上面 stEventsByType 的注释）。limit 夹在 [1,200]。
    qEventsByType(type, limit) {
      const n = Math.max(1, Math.min(Number(limit) || 20, 200));
      return stEventsByType.all(String(type || ''), n);
    },
    // metric 必须是白名单键（stats 侧已校验）；未知则回退 sessions
    qTopUsers(from, to, metric, limit) {
      const col = TOP_USER_METRICS[metric] || 'sessions';
      return stTopUsers[col].all(from, to, Math.min(Math.max(1, limit || 10), 100));
    },
    qUsersAll(from, to) { return stUsersAll.all(from, to); },
    qBlueprints(from, to) { return stBlueprints.all(from, to); },
    qBlueprintSeries(blueprintId, from, to) { return stBlueprintSeries.all(blueprintId, from, to); },
    qUserSeries(user, host, from, to) { return stUserSeries.all(user, host, from, to); },
    // recency：不带 range，看得见沉默实体（这正是它存在的理由）
    qBlueprintRecency() { return stBlueprintRecency.all(); },
    qUserRecency() { return stUserRecency.all(); },
    // 点查版：只给指定的 user@host 取 recency（普通 metric 路径用，避免为 10 行扫全表）
    qUserRecencyFor(pairs) {
      return pairs.map((p) => {
        const r = stUserRecencyOne.get(p.user, p.host);
        return { user: p.user, host: p.host, lastAt: r ? r.lastAt : null };
      });
    },

    // 回填（scripts/backfill.js）：逐日一个事务，中断可重跑
    backfillDay(day) {
      return db.transaction((d) => ({
        users: stBackfillUserDay.run(d).changes,
        blueprints: stBackfillBlueprintDay.run(d).changes,
      }))(day);
    },
    backfillFallbackBefore(cutoffDay) {
      return db.transaction((d) => ({
        users: stBackfillUserFallback.run(d).changes,
        blueprints: stBackfillBlueprintFallback.run(d).changes,
      }))(cutoffDay);
    },
    qDaysWithEvents(fromDay) { return stDistinctDaysWithEvents.all(fromDay).map((r) => r.day); },
    qHours(blueprintId, from, to) { return stHours.all({ bp: blueprintId || '', from, to }); },
    // 时段回填：整体清空后按窗口重建（回填是一次性动作，不必像夜间 job 那样只动 3 天窗）
    backfillHoursFrom(fromDay) {
      return db.transaction((f) => {
        stClearDailyHourFrom.run(f);
        return stRecomputeDailyHourGlobal.run({ fromDay: f }).changes
          + stRecomputeDailyHourBlueprint.run({ fromDay: f }).changes;
      })(fromDay);
    },
    qCountNullLastAt() { return stCountNullLastAt.get(); },
    qRealtime(cutoffIso, cutoffDay) { return stRealtime.all({ cutoffIso, cutoffDay }); },
    // 供 stats 校验 metric 合法性。silentDays 不对应任何区间列——它按不带 range 的 recency
    // 排名（stats.js 里单独走一支），故只进白名单、不进 TOP_USER_METRICS 的预编译表。
    topUserMetrics: Object.keys(TOP_USER_METRICS).concat('silentDays'),

    // ---- 鉴权（accounts / sessions）----
    qAccountByUsername(username) { return stAccountByUsername.get(username) || null; },
    insertAccount(a) {
      return stInsertAccount.run({
        username: a.username, passHash: a.passHash, salt: a.salt,
        role: a.role || 'user', createdAt: a.createdAt,
      }).changes;
    },
    listAccounts() { return stListAccounts.all(); },
    deleteAccountByUsername(username) { return stDeleteAccount.run(username).changes; },
    updateAccountPassword(username, passHash, salt) {
      return stUpdateAccountPassword.run({ username, passHash, salt }).changes;
    },
    countAdmins() { return stCountAdmins.get().c; },
    insertSession(s) {
      return stInsertSession.run({
        token: s.token, username: s.username, createdAt: s.createdAt, expiresAt: s.expiresAt,
      }).changes;
    },
    qSession(token) { return stSession.get(token) || null; },
    deleteSession(token) { return stDeleteSession.run(token).changes; },
    deleteSessionsByUser(username) { return stDeleteSessionsByUser.run(username).changes; },
    deleteExpiredSessions(nowIso) { return stDeleteExpiredSessions.run(nowIso).changes; },
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

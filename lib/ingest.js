'use strict';
// ingest.js —— POST /v1/events：校验 + 单事务批插 + 幂等聚合。
//
// 幂等三线：
// · 普通事件：events.event_id UNIQUE + INSERT OR IGNORE，changes===1 才 bump 聚合
//   ——ingest 幂等与聚合幂等是同一事务里的同一条件，spool 重发批天然不双计。
// · 心跳：不落 events（千人级 ~12 万条/日纯浪费），hb_seen 表挡重发（保留 7 天）。
// · 未知 type（v2 前向兼容）：结构合格即落 events 原始表、不做任何聚合
//   ——旧服务器遇新客户端不丢数据，升级后可在保留窗口内从原始表回填。

const express = require('express');
const { localDay } = require('./time-utils');
const { ingestFrameworkIssue } = require('./fw-ingest');

// v1 已知类型（决定是否参与聚合；名单外的 type 只存原始）
// 客户端镜像清单：TechDemos server-telemetry/event-registry.js（parity 用例守卫漂移，两端同步改）
const KNOWN_TYPES = new Set([
  'instance_online', 'instance_heartbeat', 'session_start', 'session_end',
  'bp_run_start', 'bp_run_end', 'failure_event', 'update_apply',
  'artifact_review_reject',
  'framework_issue',
]);
// 自进化样本（bp_patch_proposal / bp_patch_verdict / evolve_run_summary）已拆到 cancong-evolve，不进本服务
// （TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §7.2：客户端按 sinks 只把它们发给自进化服务）。

// ms 值净化：与 db.js 的 msExpr SQL 片段同口径（正有限数才计入，夜间补算不会把垃圾值补回去）
function msOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// tool 名净化：与 db.js 的 TOOL_EXPR 同口径（缺失/空串归 'unknown'）
function toolOf(payload) {
  const t = payload ? payload.tool : null;
  return (t != null && String(t) !== '') ? String(t) : 'unknown';
}

// failure kind 净化：与 db.js recompute 的 COALESCE(NULLIF(...)) 同口径（缺失/空串归 'unknown'）
function kindOf(payload) {
  const k = payload ? payload.kind : null;
  return (k != null && String(k) !== '') ? String(k) : 'unknown';
}

// app_version 净化：daily_fail PK 不容 NULL，缺失归 'unknown'（与 recompute COALESCE 同口径）
function versionOf(ev) {
  return (typeof ev.appVersion === 'string' && ev.appVersion !== '') ? ev.appVersion : 'unknown';
}

// 参与 recency 的事件类型（实质使用）——心跳与 instance_online、update_apply 刻意不算。
// 与 db.js 的 RECENCY_TYPES 同名单，两端同步改（有测试守漂移）。
const RECENCY_TYPES = new Set(['session_start', 'session_end', 'bp_run_end', 'failure_event']);
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * 事件「真实发生时刻」：取 client_ts，异常时回落 server_ts。与 db.js 的 EVENT_AT_EXPR 同口径
 * （夜间重算与回填走 SQL 那份，逐例一致性有 __tests__/recency.test.js 守着）。
 *
 * 为什么不用 server_ts：客户端有 spool 断网缓冲，用接收时刻会把断网 3 天后重连补发的活动
 * 记成「今天」——过报新鲜度，恰是 recency 最该避免的失效方向。
 * 为什么阀是单向的：只有 client_ts **晚于** server_ts 才可能是时钟走快（物理不可能）；
 * client_ts 比 server_ts 早很多是**正常**的补发，拿"差值大"当判据会把断网用户的真实时刻全删掉。
 * 归一为 toISOString()：保证字典序 = 时间序（SQL 侧靠字符串比较取 MAX），也吃得下带偏移的格式。
 */
function eventAtOf(ev, serverTs, serverMs) {
  const t = typeof ev.ts === 'string' ? Date.parse(ev.ts) : NaN;
  if (!Number.isFinite(t)) return serverTs;                 // 缺失/不可解析（ts 是选填字段）
  if (t > serverMs + CLOCK_SKEW_TOLERANCE_MS) return serverTs; // 时钟走快
  return new Date(t).toISOString();
}

/**
 * 时段分桶：把事件落到 (本地日, 本地小时)。与 db.js 的 CLIENT_DAY_EXPR/CLIENT_HOUR_EXPR
 * 同口径（夜间重算与回填走 SQL 那份，逐例对拍见 __tests__/hours.test.js）。
 *
 * 与 recency 的关键差别：**不合格就丢弃**（返回 null），不回落 server_ts。
 * recency 有个值比没有强；而时段分布里一个错误的小时会直接污染分布形状，宁可少一个样本。
 * 丢弃要计数并在 UI 上暴露，否则这是静默漏数据。
 *
 * client_ts 是 UTC（客户端从不上报偏移，见 docs/CLIENT-HANDOFF.md §3），故只能按**部署机时区**
 * 解读成"几点"。TZ 一旦定下不可改——见 docs/DEPLOYMENT.md §4.1。
 * @returns {{day: string, hour: number} | null}
 */
function hourBucketOf(ev, serverMs) {
  const t = typeof ev.ts === 'string' ? Date.parse(ev.ts) : NaN;
  if (!Number.isFinite(t)) return null;                     // 缺失/不可解析
  if (t > serverMs + CLOCK_SKEW_TOLERANCE_MS) return null;  // 时钟走快
  const d = new Date(t);
  const day = d.getFullYear()
    + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
  return { day, hour: d.getHours() };
}

// blueprintId（工作流归因键）：缺失/空串归 null（不归因工作流），与 recompute 的 IS NOT NULL/!='' 同口径
function blueprintIdOf(ev) {
  const b = ev.payload ? ev.payload.blueprintId : null;
  return (b != null && String(b) !== '') ? String(b) : null;
}

function nonEmptyStr(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

// 逐事件校验；不合格跳过该事件而非整批拒绝（客户端 spool 按整批补发，一颗老鼠屎不堵补发流）
function validate(ev) {
  return !!ev && typeof ev === 'object'
    && ev.schemaVersion === 1
    && nonEmptyStr(ev.eventId, 128)
    && nonEmptyStr(ev.type, 64)
    && nonEmptyStr(ev.installId, 128)
    && nonEmptyStr(ev.user, 256)
    && nonEmptyStr(ev.host, 256);
}

// live_sessions 仅 heartbeat / instance_online 携带（其余事件返回 null，upsert 不覆盖）
function pickLiveSessions(ev) {
  if (ev.type !== 'instance_heartbeat' && ev.type !== 'instance_online') return null;
  const n = Number(ev.payload ? ev.payload.liveSessions : NaN);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// type → daily_user 增量；null = 只存原始不 bump（bp_run_start：run 计数以终态为准，避免跨日双计）
function deltasOf(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'session_start': return { sessions: 1 };
    // session_end 的 token 是「总量权威」→ daily_user；run 级 token 归 daily_blueprint（防双计）
    case 'session_end': return { sessionMs: msOf(p.durationMs), inTokens: msOf(p.inputTokens), outTokens: msOf(p.outputTokens) };
    case 'bp_run_end': {
      const d = { runActiveMs: msOf(p.activeMs) };
      if (p.status === 'done') d.runsDone = 1;
      else if (p.status === 'failed') d.runsFailed = 1;
      else if (p.status === 'halted') d.runsHalted = 1;
      return d;
    }
    case 'failure_event': return { failures: 1 };
    case 'instance_online': return {}; // 全 0 bump：确保当日 daily 行存在
    // 制品审批「拒绝」样本（TechDemos docs/ARTIFACT-REVIEW-DESIGN.md §11）：**价值在原始 payload**
    // （被拒的意见全文 + AI 回复），用来改进生成制品的那个 prompt，不是一个计数指标。
    // 故同样走全 0 bump 只保当日行存在，**不新增任何聚合列** —— 加了列就得同步改 db.js 的
    // recompute SQL，漏一处夜间 3:00 的补算会把 ingest 写对的值重算成 0，而且从数据看不出来。
    // ⚠ 样本随 events 表按 OPS_RETENTION_DAYS（默认 90）整表清理，见 docs/API.md。
    case 'artifact_review_reject': return {};
    // 框架问题（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §6.3）：同上理由，daily 只保当日行；
    // fw_issues 由下方 ingestFrameworkIssue 在同一事务里增量 upsert。
    case 'framework_issue': return {};
    // update_apply 不计 daily_user.failures（装失败是安装面问题，不该算进用户失败指标）；
    // 返回 {} 走全 0 bump，让下方 else-if 有机会把 ok:false 记进 daily_fail（按 reason 分组）
    case 'update_apply': return {};
    default: return null;
  }
}

// 单事务吃下整批：校验失败 rejected、重发 dup、其余 accepted；整批共用一个时钟读数
// （跨午夜批的归日误差 ≤1 批 ≤500 事件，可忽略）
function ingestBatch(dao, events, now) {
  const serverTs = now.toISOString();
  const serverMs = now.getTime();
  const day = localDay(now);
  let accepted = 0, dup = 0, rejected = 0, hourDropped = 0, unknownType = 0;
  dao.txIngest(() => {
    for (const ev of events) {
      if (!validate(ev)) { rejected++; continue; }
      dao.upsertInstall({
        installId: ev.installId, user: ev.user, host: ev.host,
        platform: typeof ev.platform === 'string' ? ev.platform : null,
        appVersion: typeof ev.appVersion === 'string' ? ev.appVersion : null,
        channel: typeof ev.channel === 'string' ? ev.channel : null,
        nowIso: serverTs, liveSessions: pickLiveSessions(ev),
      });
      if (ev.type === 'instance_heartbeat') {
        if (dao.markHbSeen(ev.eventId, day)) {
          dao.bumpDaily(day, ev.installId, ev.user, ev.host, { heartbeats: 1 });
          accepted++;
        } else {
          dup++;
        }
        continue;
      }
      const inserted = dao.insertEvent({
        eventId: ev.eventId, installId: ev.installId, user: ev.user, host: ev.host,
        type: ev.type, clientTs: typeof ev.ts === 'string' ? ev.ts : null,
        serverTs, day,
        appVersion: typeof ev.appVersion === 'string' ? ev.appVersion : null,
        payload: JSON.stringify(ev.payload == null ? {} : ev.payload),
      }) === 1;
      if (!inserted) { dup++; continue; } // 幂等门：没插进去就绝不 bump
      accepted++;
      // ★ 未知 type 仍按前向兼容落原始表（上面已 insert），但这里**计数**：
      //   客户端加了新事件类型而这边 KNOWN_TYPES 没跟上时，症状是「看板零样本 + 零报错
      //   + 零日志」，与「客户端压根没发」完全无法区分。计出来、在总览上暴露，漂移才会
      //   自己叫出来。（与下面 hourDropped 同一条理由：丢弃要计数并在 UI 上暴露。）
      if (!KNOWN_TYPES.has(ev.type)) { unknownType++; continue; }
      const d = deltasOf(ev);
      if (d == null) continue;
      // recency 与时段分布共用同一份「实质使用」名单——「使用」的定义只该有一个
      const substantive = RECENCY_TYPES.has(ev.type);
      const eventAt = substantive ? eventAtOf(ev, serverTs, serverMs) : null;
      if (eventAt) d.lastAt = eventAt;
      dao.bumpDaily(day, ev.installId, ev.user, ev.host, d);

      // 时段分桶（作息）。全局行 blueprint_id=''；带 blueprintId 的另记一行——
      // 两者**不是**和的关系（会话类事件无 blueprintId，只进全局行）。
      let bucket = null;
      if (substantive) {
        bucket = hourBucketOf(ev, serverMs);
        if (bucket) {
          dao.bumpDailyHour(bucket.day, bucket.hour, '', {
            events: 1,
            sessions: ev.type === 'session_start' ? 1 : 0,
            runs: ev.type === 'bp_run_end' ? 1 : 0,
          });
        } else {
          hourDropped++; // 时钟异常/无 ts：丢出时段统计并计数（批末一次性落库）
        }
      }
      // 框架问题表：幂等门之后、同一事务内 ⇒ 重发批不双计
      if (ev.type === 'framework_issue') ingestFrameworkIssue(dao, ev, serverTs);
      if (ev.type === 'session_start') {
        dao.bumpDailyTool(day, toolOf(ev.payload), 1, 0);
      } else if (ev.type === 'session_end') {
        dao.bumpDailyTool(day, toolOf(ev.payload), 0, msOf((ev.payload || {}).durationMs));
      } else if (ev.type === 'bp_run_end') {
        // 工作流归因：runs 按 status、activeMs（E2E）、interruptions（用户中断）、run 级 token
        const bp = blueprintIdOf(ev);
        if (bp) {
          const p = ev.payload || {};
          dao.bumpDailyBlueprint(day, bp, {
            runsDone: p.status === 'done' ? 1 : 0,
            runsFailed: p.status === 'failed' ? 1 : 0,
            runsHalted: p.status === 'halted' ? 1 : 0,
            activeMs: msOf(p.activeMs), interruptions: msOf(p.interruptions),
            inTokens: msOf(p.inputTokens), outTokens: msOf(p.outputTokens),
            lastAt: eventAt,
          });
          if (bucket) dao.bumpDailyHour(bucket.day, bucket.hour, bp, { events: 1, runs: 1 });
        }
      } else if (ev.type === 'failure_event') {
        dao.bumpDailyFail(day, versionOf(ev), kindOf(ev.payload));
        const bp = blueprintIdOf(ev); // 失败归因到具体工作流（带 blueprintId 才归因）
        if (bp) {
          dao.bumpDailyBlueprint(day, bp, { failures: 1, lastAt: eventAt });
          if (bucket) dao.bumpDailyHour(bucket.day, bucket.hour, bp, { events: 1 });
        }
      } else if (ev.type === 'update_apply') {
        // 装失败进 daily_fail（kind='update:<reason>'）→ 失败页 kind 分布可见；
        // 装成功只存原始（升级铺开进度靠 installs.appVersion 分布，无需聚合）。
        // 注：此处 appVersion 是 to（emit 时进程已是新版）——按目标版本归组是刻意的。
        const p = ev.payload || {};
        if (p.ok === false) dao.bumpDailyFail(day, versionOf(ev), 'update:' + ((p.reason != null && String(p.reason) !== '') ? String(p.reason) : 'unknown'));
      }
    }
    // 丢弃计数在同一事务里落库，与它对应的那批事件同生共死
    dao.bumpHourDropped(hourDropped);
    dao.bumpUnknownTypes(unknownType);
  })();
  return { accepted, dup, rejected };
}

function createIngestRouter(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const router = express.Router();
  router.post('/events', (req, res) => {
    const body = req.body;
    if (!body || !Array.isArray(body.events) || body.events.length > 500) {
      return res.status(400).json({ ok: false, error: 'bad batch' });
    }
    try {
      const r = ingestBatch(dao, body.events, nowFn());
      const out = { ok: true, accepted: r.accepted, dup: r.dup };
      if (r.rejected > 0) out.rejected = r.rejected; // 契约纯增量字段
      res.json(out);
    } catch (e) {
      console.log('[ingest] error:', e.message);
      res.status(500).json({ ok: false, error: 'ingest failed' });
    }
  });
  return router;
}

module.exports = { createIngestRouter, ingestBatch, KNOWN_TYPES, RECENCY_TYPES, eventAtOf, hourBucketOf };

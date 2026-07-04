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

// v1 已知类型（决定是否参与聚合；名单外的 type 只存原始）
const KNOWN_TYPES = new Set([
  'instance_online', 'instance_heartbeat', 'session_start', 'session_end',
  'bp_run_start', 'bp_run_end', 'failure_event',
]);

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
    default: return null;
  }
}

// 单事务吃下整批：校验失败 rejected、重发 dup、其余 accepted；整批共用一个时钟读数
// （跨午夜批的归日误差 ≤1 批 ≤500 事件，可忽略）
function ingestBatch(dao, events, now) {
  const serverTs = now.toISOString();
  const day = localDay(now);
  let accepted = 0, dup = 0, rejected = 0;
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
      if (!KNOWN_TYPES.has(ev.type)) continue;
      const d = deltasOf(ev);
      if (d == null) continue;
      dao.bumpDaily(day, ev.installId, ev.user, ev.host, d);
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
          });
        }
      } else if (ev.type === 'failure_event') {
        dao.bumpDailyFail(day, versionOf(ev), kindOf(ev.payload));
        const bp = blueprintIdOf(ev); // 失败归因到具体工作流（带 blueprintId 才归因）
        if (bp) dao.bumpDailyBlueprint(day, bp, { failures: 1 });
      }
    }
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

module.exports = { createIngestRouter, ingestBatch, KNOWN_TYPES };

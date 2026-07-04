'use strict';
// seed-demo.js —— 灌少量确定性演示数据到指定库，供本地手测看板（非测试、非生产）。
// 用法：node scripts/seed-demo.js [--db ./data/demo.db] [--installs 40] [--days 30]

const { openDb } = require('../lib/db');
const { ingestBatch } = require('../lib/ingest');
const { localDay, shiftDay } = require('../lib/time-utils');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
}

const DB_PATH = String(arg('db', './data/demo.db'));
const INSTALLS = Number(arg('installs', 40));
const DAYS = Number(arg('days', 30));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42);
const TOOLS = ['claude', 'codex', 'gemini', 'cursor'];
const VERSIONS = ['1.4.0', '1.3.2', '1.2.9'];
const KINDS = ['rate_limit', 'auth', 'network', 'oom'];
const STATUSES = ['done', 'done', 'done', 'failed', 'halted'];
const BLUEPRINTS = ['ship-it', 'fix-tests', 'review-pr', 'refactor', 'docs-gen']; // 工作流（内部 blueprintId）
const pick = (a) => a[Math.floor(rng() * a.length)];
const pad = (n) => String(n).padStart(3, '0');

let seq = 0;
function ev(over) {
  seq++;
  return Object.assign({
    schemaVersion: 1, eventId: 'seed-' + seq, type: 'session_start',
    ts: '2026-07-02T09:30:00+08:00', installId: 'inst', user: 'u', host: 'h',
    platform: 'win32', appVersion: '1.4.0', channel: 'packaged', bootId: 'b', payload: {},
  }, over);
}

const { dao, close } = openDb(DB_PATH);
const now = new Date();

for (let d = DAYS - 1; d >= 0; d--) {
  const at = new Date(now.getTime() - d * 24 * 3600 * 1000);
  const activeToday = Math.max(3, Math.floor(INSTALLS * (0.4 + rng() * 0.4)));
  for (let i = 1; i <= activeToday; i++) {
    const inst = 1 + Math.floor(rng() * INSTALLS);
    const id = { installId: 'inst-' + pad(inst), user: 'user' + pad(inst), host: 'HOST-' + pad(inst), appVersion: pick(VERSIONS) };
    const batch = [ev({ ...id, type: 'instance_heartbeat', payload: { liveSessions: Math.floor(rng() * 3) } })];
    const nSess = Math.floor(rng() * 4);
    for (let s = 0; s < nSess; s++) {
      const tool = pick(TOOLS);
      batch.push(ev({ ...id, type: 'session_start', payload: { tool, cwdHash: 'h' + inst } }));
      batch.push(ev({ ...id, type: 'session_end', payload: { tool, durationMs: Math.floor(rng() * 3600000), exitCode: 0,
        inputTokens: Math.floor(rng() * 40000), outputTokens: Math.floor(rng() * 8000) } }));
    }
    const nRun = Math.floor(rng() * 3);
    for (let r = 0; r < nRun; r++) {
      const bp = pick(BLUEPRINTS);
      batch.push(ev({ ...id, type: 'bp_run_end', payload: { blueprintId: bp, runId: 'r' + seq, status: pick(STATUSES),
        activeMs: Math.floor(rng() * 600000), interruptions: Math.floor(rng() * 3),
        inputTokens: Math.floor(rng() * 20000), outputTokens: Math.floor(rng() * 4000) } }));
    }
    if (rng() < 0.25) {
      batch.push(ev({ ...id, type: 'failure_event', payload: { source: 'error_autoresume', kind: pick(KINDS),
        reason: 'demo failure sample', tool: pick(TOOLS), blueprintId: pick(BLUEPRINTS) } }));
    }
    ingestBatch(dao, batch, at);
  }
}

// 实时视图：把最近 24 小时按分钟撒事件（每分钟以一定概率来一小批），让分钟趋势有分布
for (let m = 0; m < 24 * 60; m++) {
  if (rng() > 0.5) continue; // ~半数分钟有活动
  const at = new Date(now.getTime() - m * 60000);
  const inst = 1 + Math.floor(rng() * INSTALLS);
  const id = { installId: 'inst-' + pad(inst), user: 'user' + pad(inst), host: 'HOST-' + pad(inst), appVersion: pick(VERSIONS) };
  const batch = [];
  const nSess = 1 + Math.floor(rng() * 3);
  for (let s = 0; s < nSess; s++) {
    const tool = pick(TOOLS);
    batch.push(ev({ ...id, type: 'session_start', payload: { tool } }));
    batch.push(ev({ ...id, type: 'session_end', payload: { tool, durationMs: Math.floor(rng() * 600000),
      inputTokens: Math.floor(rng() * 20000), outputTokens: Math.floor(rng() * 4000) } }));
  }
  if (rng() < 0.6) {
    batch.push(ev({ ...id, type: 'bp_run_end', payload: { blueprintId: pick(BLUEPRINTS), runId: 'rt' + seq,
      status: pick(STATUSES), activeMs: Math.floor(rng() * 300000), interruptions: Math.floor(rng() * 2),
      inputTokens: Math.floor(rng() * 8000), outputTokens: Math.floor(rng() * 2000) } }));
  }
  if (rng() < 0.15) batch.push(ev({ ...id, type: 'failure_event', payload: { kind: pick(KINDS), blueprintId: pick(BLUEPRINTS) } }));
  ingestBatch(dao, batch, at);
}

// 让约 30% 实例最后活动落在 10 分钟内（看板显示"在线"）：给它们补一条 now 心跳
const insts = dao.qInstalls();
for (const it of insts) {
  if (rng() < 0.3) {
    ingestBatch(dao, [ev({ installId: it.installId, user: it.user, host: it.host, appVersion: it.appVersion,
      type: 'instance_heartbeat', payload: { liveSessions: Math.floor(rng() * 4) } })], now);
  }
}

console.log('[seed] done: installs=' + dao.qInstalls().length + ' db=' + DB_PATH);
close();

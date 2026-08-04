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
// at：该事件的模拟发生时刻，同时用作 ingestBatch 的接收时刻，故 **ts 必须恰好等于 at**。
//
// 早先这里在 at 的基础上另撒一个 9~18 点的随机时刻，结果 ts 常常**晚于**接收时刻——
// 那是物理不可能的（时钟走快），ingest 的单向未来阀会把它剔出时段统计，实测演示库
// 28% 的事件被丢掉。阀本身没错，是造数造出了不可能的数据。工作时段的分布改由调用方
// 在算 at 时决定（见下面日循环里的 workHour），这里只忠实转写。
//
// ts 也是 recency（last_at）的来源——写死成常量会让所有实体的「上次活跃」停在同一刻。
function ev(over, at) {
  seq++;
  return Object.assign({
    schemaVersion: 1, eventId: 'seed-' + seq, type: 'session_start',
    ts: (at || new Date()).toISOString(), installId: 'inst', user: 'u', host: 'h',
    platform: 'win32', appVersion: '1.4.0', channel: 'packaged', bootId: 'b', payload: {},
  }, over);
}

// 当天 9:00~17:59 之间的一个随机时刻——让作息热力图有像样的工作时段分布
function workHour(base) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(),
    9 + Math.floor(rng() * 9), Math.floor(rng() * 60), Math.floor(rng() * 60));
}

const { dao, close } = openDb(DB_PATH);
const now = new Date();

for (let d = DAYS - 1; d >= 0; d--) {
  const dayBase = new Date(now.getTime() - d * 24 * 3600 * 1000);
  const activeToday = Math.max(3, Math.floor(INSTALLS * (0.4 + rng() * 0.4)));
  for (let i = 1; i <= activeToday; i++) {
    // 每个实例在当天工作时段里挑一个时刻；ts 与接收时刻同为它，绝不出现"未来事件"
    const at = workHour(dayBase);
    const inst = 1 + Math.floor(rng() * INSTALLS);
    const id = { installId: 'inst-' + pad(inst), user: 'user' + pad(inst), host: 'HOST-' + pad(inst), appVersion: pick(VERSIONS) };
    const batch = [ev({ ...id, type: 'instance_heartbeat', payload: { liveSessions: Math.floor(rng() * 3) } }, at)];
    const nSess = Math.floor(rng() * 4);
    for (let s = 0; s < nSess; s++) {
      const tool = pick(TOOLS);
      batch.push(ev({ ...id, type: 'session_start', payload: { tool, cwdHash: 'h' + inst } }, at));
      batch.push(ev({ ...id, type: 'session_end', payload: { tool, durationMs: Math.floor(rng() * 3600000), exitCode: 0,
        inputTokens: Math.floor(rng() * 40000), outputTokens: Math.floor(rng() * 8000) } }, at));
    }
    const nRun = Math.floor(rng() * 3);
    for (let r = 0; r < nRun; r++) {
      const bp = pick(BLUEPRINTS);
      batch.push(ev({ ...id, type: 'bp_run_end', payload: { blueprintId: bp, runId: 'r' + seq, status: pick(STATUSES),
        activeMs: Math.floor(rng() * 600000), interruptions: Math.floor(rng() * 3),
        inputTokens: Math.floor(rng() * 20000), outputTokens: Math.floor(rng() * 4000) } }, at));
    }
    if (rng() < 0.25) {
      batch.push(ev({ ...id, type: 'failure_event', payload: { source: 'error_autoresume', kind: pick(KINDS),
        reason: 'demo failure sample', tool: pick(TOOLS), blueprintId: pick(BLUEPRINTS) } }, at));
    }
    ingestBatch(dao, batch, at);
  }
}

// 沉默维度（P2）演示：光靠上面的随机分布，每个工作流天天都有人跑，沉默列永远是「今天」，
// 看不出这个特性做了什么。这里显式造三个「用过就再没用」的实体：
//   · legacy-deploy —— 早期跑 6 次后停用 → 累计 ≥3，**进沉默名单**（区间内零活动，指标全 0）
//   · oneoff-spike  —— 早期只跑 1 次     → 累计 <3，**被准入线挡掉**（表底报"已隐藏 N 个"）
//   · user900       —— 早期活跃后消失     → 用户页切「沉默天数」metric 能排到最前
const silentAt = workHour(new Date(now.getTime() - Math.floor(DAYS * 0.85) * 24 * 3600 * 1000));
const silentId = { installId: 'inst-900', user: 'user900', host: 'HOST-900', appVersion: VERSIONS[2] };
for (let i = 0; i < 6; i++) {
  ingestBatch(dao, [ev({ ...silentId, type: 'bp_run_end',
    payload: { blueprintId: 'legacy-deploy', runId: 'legacy-' + i, status: 'done',
      activeMs: 120000 + i * 1000, interruptions: 0, inputTokens: 3000, outputTokens: 800 } }, silentAt)], silentAt);
}
ingestBatch(dao, [
  ev({ ...silentId, type: 'bp_run_end',
    payload: { blueprintId: 'oneoff-spike', runId: 'oneoff-1', status: 'failed', activeMs: 4000 } }, silentAt),
  ev({ ...silentId, type: 'session_start', payload: { tool: 'claude' } }, silentAt),
  ev({ ...silentId, type: 'session_end', payload: { tool: 'claude', durationMs: 600000,
    inputTokens: 12000, outputTokens: 2500 } }, silentAt),
], silentAt);

// 实时视图：把最近 24 小时按分钟撒事件（每分钟以一定概率来一小批），让分钟趋势有分布
// 密度刻意压到 ~15%：这块的事件全部落在最近一天，密度过高会让「作息」热力图变成
// 「全员只在今天上班」的一条亮带，把周模式整个盖掉（实测 50% 时今天占全周 74%）。
// 15% × ~1440 分钟仍有两百多个非空分钟桶，实时视图照样有分布可看。
for (let m = 0; m < 24 * 60; m++) {
  if (rng() > 0.15) continue;
  const at = new Date(now.getTime() - m * 60000);
  const inst = 1 + Math.floor(rng() * INSTALLS);
  const id = { installId: 'inst-' + pad(inst), user: 'user' + pad(inst), host: 'HOST-' + pad(inst), appVersion: pick(VERSIONS) };
  const batch = [];
  const nSess = 1;
  for (let s = 0; s < nSess; s++) {
    const tool = pick(TOOLS);
    batch.push(ev({ ...id, type: 'session_start', payload: { tool } }, at));
    batch.push(ev({ ...id, type: 'session_end', payload: { tool, durationMs: Math.floor(rng() * 600000),
      inputTokens: Math.floor(rng() * 20000), outputTokens: Math.floor(rng() * 4000) } }, at));
  }
  if (rng() < 0.6) {
    batch.push(ev({ ...id, type: 'bp_run_end', payload: { blueprintId: pick(BLUEPRINTS), runId: 'rt' + seq,
      status: pick(STATUSES), activeMs: Math.floor(rng() * 300000), interruptions: Math.floor(rng() * 2),
      inputTokens: Math.floor(rng() * 8000), outputTokens: Math.floor(rng() * 2000) } }, at));
  }
  if (rng() < 0.15) batch.push(ev({ ...id, type: 'failure_event', payload: { kind: pick(KINDS), blueprintId: pick(BLUEPRINTS) } }, at));
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

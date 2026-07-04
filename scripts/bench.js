'use strict';
// bench.js —— M2 验收压测（非测试）：灌 ~700 万行 events → 全量重算聚合 → 逐查询 p50/p95。
//
// 用法：node scripts/bench.js [--rows 7000000] [--installs 1100] [--days 90] [--db ./bench.db]
// 验收线（设计文档 M2「本地灌 700 万行压测查询毫秒级」的落地口径）：
//   daily_user / daily_tool 系查询 p95 < 20ms；installs 系 < 5ms；
//   failures 按版本失败率（读 events 原始表，全套唯一放宽项）p95 < 300ms。

const fs = require('fs');
const path = require('path');

const { openDb } = require('../lib/db');
const { localDay, shiftDay } = require('../lib/time-utils');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
}

const ROWS = Number(arg('rows', 7000000));
const INSTALLS = Number(arg('installs', 1100));
const DAYS = Number(arg('days', 90));
const DB_PATH = String(arg('db', path.join(__dirname, '..', 'bench.db')));

// 确定性伪随机（mulberry32）：同参数复跑结果可比
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260702);

const TOOLS = ['claude', 'codex', 'gemini', 'cursor'];
const VERSIONS = ['1.4.0', '1.3.2', '1.2.9'];
const KINDS = ['rate_limit', 'auth', 'network', 'oom', 'unknown'];
const STATUSES = ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'failed', 'halted']; // ≈ 82/9/9

function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }
function pad(n, w) { return String(n).padStart(w, '0'); }

function main() {
  // 每次全新库（连 -wal/-shm 一起清）
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch (_) {}
  }
  console.log('[bench] db=' + DB_PATH + ' rows=' + ROWS + ' installs=' + INSTALLS + ' days=' + DAYS);
  const { db, dao, close } = openDb(DB_PATH);

  const now = new Date();
  const today = localDay(now);
  const dayPool = [];
  for (let i = DAYS - 1; i >= 0; i--) dayPool.push(shiftDay(today, -i));

  // ---- 1) installs 注册（约 60% 近期活跃、其中一小撮 10 分钟内在线）----
  for (let i = 1; i <= INSTALLS; i++) {
    const backMs = rng() < 0.02 ? rng() * 9 * 60 * 1000                    // 2% 在线（<10min）
      : rng() < 0.6 ? rng() * 7 * 24 * 3600 * 1000                        // 活跃在 7 天内
        : rng() * DAYS * 24 * 3600 * 1000;                                // 其余散在保留期内
    dao.upsertInstall({
      installId: 'inst-' + pad(i, 4), user: 'user' + pad(i, 4), host: 'HOST-' + pad(i, 4),
      platform: rng() < 0.7 ? 'win32' : 'linux', appVersion: pick(VERSIONS),
      channel: 'packaged', nowIso: new Date(now.getTime() - backMs).toISOString(),
      liveSessions: Math.floor(rng() * 4),
    });
  }
  console.log('[bench] installs seeded');

  // ---- 2) 灌 events（37.5% start / 37.5% end / 20% run_end / 5% failure）----
  const t0 = Date.now();
  const CHUNK = 10000;
  const insertMany = db.transaction((rows) => { for (const r of rows) dao.insertEvent(r); });
  let buf = [];
  for (let i = 0; i < ROWS; i++) {
    const inst = 1 + Math.floor(rng() * INSTALLS);
    const day = dayPool[Math.floor(rng() * DAYS)];
    const ts = day + 'T' + pad(Math.floor(rng() * 24), 2) + ':' + pad(Math.floor(rng() * 60), 2)
      + ':' + pad(Math.floor(rng() * 60), 2) + '.000Z';
    const r = rng();
    let type, payload;
    if (r < 0.375) { type = 'session_start'; payload = '{"tool":"' + pick(TOOLS) + '","cwdHash":"abcdef012345"}'; }
    else if (r < 0.75) { type = 'session_end'; payload = '{"tool":"' + pick(TOOLS) + '","durationMs":' + Math.floor(rng() * 3600000) + ',"exitCode":0,"inputTokens":' + Math.floor(rng() * 40000) + ',"outputTokens":' + Math.floor(rng() * 8000) + '}'; }
    else if (r < 0.95) { type = 'bp_run_end'; payload = '{"blueprintId":"bp-' + Math.floor(rng() * 20) + '","runId":"r' + i + '","status":"' + pick(STATUSES) + '","activeMs":' + Math.floor(rng() * 1800000) + ',"interruptions":' + Math.floor(rng() * 4) + ',"inputTokens":' + Math.floor(rng() * 20000) + ',"outputTokens":' + Math.floor(rng() * 4000) + '}'; }
    else { type = 'failure_event'; payload = '{"source":"error_autoresume","kind":"' + pick(KINDS) + '","reason":"bench","tool":"' + pick(TOOLS) + '"' + (rng() < 0.6 ? ',"blueprintId":"bp-' + Math.floor(rng() * 20) + '"' : '') + '}'; }
    buf.push({
      eventId: 'b-' + i, installId: 'inst-' + pad(inst, 4),
      user: 'user' + pad(inst, 4), host: 'HOST-' + pad(inst, 4),
      type, clientTs: null, serverTs: ts, day, appVersion: pick(VERSIONS), payload,
    });
    if (buf.length >= CHUNK) {
      insertMany(buf); buf = [];
      if ((i + 1) % 500000 === 0) {
        const rate = Math.round((i + 1) / ((Date.now() - t0) / 1000));
        console.log('[bench] inserted ' + (i + 1) + ' rows (' + rate + ' rows/s)');
      }
    }
  }
  if (buf.length) insertMany(buf);
  console.log('[bench] events done in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  // ---- 3) 全量重算聚合（顺带压测补算 SQL 本身）+ optimize（生产由夜间 job 做）----
  const t1 = Date.now();
  dao.recomputeDaily('0000-01-01');
  dao.recomputeDailyTool('0000-01-01');
  dao.recomputeDailyFail('0000-01-01');
  dao.recomputeDailyBlueprint('0000-01-01');
  dao.optimize(); // 刷新计划器统计，让 partial 覆盖索引被正确选中（等价夜间 job 的 optimize）
  console.log('[bench] full recompute in ' + ((Date.now() - t1) / 1000).toFixed(1) + 's; daily_user rows='
    + db.prepare('SELECT COUNT(*) c FROM daily_user').get().c
    + ' daily_fail rows=' + db.prepare('SELECT COUNT(*) c FROM daily_fail').get().c
    + ' daily_blueprint rows=' + db.prepare('SELECT COUNT(*) c FROM daily_blueprint').get().c);

  // ---- 4) 查询计时（每项 20 次取 p50/p95）----
  const from30 = shiftDay(today, -29), from90 = shiftDay(today, -89);
  const onlineSince = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const since30d = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

  // 验收线：daily_* / installs 系走小表或主键，个位数~几十毫秒；failures kinds/byVersion 走
  // daily_fail 小表与 ix_runend_ver 覆盖索引；dau 90 天含 WAU 滑窗 DISTINCT（99k 行字符串去重）
  // 属设计文档 §8.2 明确容忍的「100–300ms 偶发趋势查询」，故单列 <200ms 而非 <20ms。
  const cases = [
    ['overview（4 查询合）', () => {
      dao.qCountActiveUsersOn(today); dao.qCountActiveUsersSince(shiftDay(today, -6));
      dao.qCountOnline(onlineSince); dao.qTodayTotals(today);
    }, 20],
    ['dau 90 天（含 WAU 明细，§8.2）', () => { dao.qDauRange(from90, today); dao.qDauUsers(shiftDay(from90, -6), today); }, 200],
    ['versions', () => dao.qVersions(since30d), 5],
    ['tools 30 天', () => dao.qTools(from30, today), 20],
    ['runs 30 天', () => dao.qRuns(from30, today), 20],
    ['failures kinds 30 天（daily_fail）', () => dao.qFailureKinds(from30, today), 20],
    ['failures byVersion 30 天', () => { dao.qFailuresByVersion(from30, today); dao.qRunEndsByVersion(from30, today); }, 300],
    ['failures recent 100', () => dao.qRecentFailures(from30, today, 100), 20],
    ['users/top 30 天（token 排序）', () => dao.qTopUsers(from30, today, 'tokens', 10), 50],
    ['blueprints 30 天', () => dao.qBlueprints(from30, today), 20],
    ['installs 明细', () => dao.qInstalls(), 5],
  ];

  console.log('\n查询               p50(ms)   p95(ms)   验收线');
  let pass = true;
  for (const [name, fn, line] of cases) {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const s = process.hrtime.bigint();
      fn();
      times.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    times.sort((a, b) => a - b);
    const p50 = times[9], p95 = times[18];
    const ok = p95 < line;
    if (!ok) pass = false;
    console.log(name.padEnd(28) + p50.toFixed(2).padStart(8) + p95.toFixed(2).padStart(10)
      + ('<' + line).padStart(9) + (ok ? '  PASS' : '  FAIL'));
  }

  const size = fs.statSync(DB_PATH).size;
  console.log('\n[bench] db size = ' + (size / 1024 / 1024).toFixed(0) + ' MB');
  console.log('[bench] ' + (pass ? 'ALL PASS' : 'SOME FAIL'));
  close();
  process.exit(pass ? 0 : 1);
}

main();

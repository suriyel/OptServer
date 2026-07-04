'use strict';
// aggregate.test.js —— 夜间 job：补算复原（heartbeats 除外，坑 C）、缺行补建、
// 清理边界、hb_seen 清理、记账、调度边界、启动补跑、防重入

const test = require('node:test');
const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');

const { openTempDb, makeEvent } = require('./helpers');
const { ingestBatch } = require('../lib/ingest');
const { runNightlyJob, startScheduler, msUntilNextRun } = require('../lib/aggregate');
const { localDay, shiftDay } = require('../lib/time-utils');

const NOW = new Date(2026, 6, 2, 12, 0, 0); // 本地 2026-07-02 12:00
const TODAY = localDay(NOW);
const nowFn = () => NOW;

function seedOneDay(dao) {
  ingestBatch(dao, [
    makeEvent({ type: 'session_start', payload: { tool: 'claude' } }),
    makeEvent({ type: 'session_end', payload: { tool: 'claude', durationMs: 8000 } }),
    makeEvent({ type: 'bp_run_end', payload: { status: 'done', activeMs: 3000 } }),
    makeEvent({ type: 'failure_event', payload: { kind: 'x' } }),
    makeEvent({ type: 'instance_heartbeat', payload: { liveSessions: 1 } }),
  ], NOW);
}

test('补算复原事件派生列，heartbeats 保持原值（坑 C）', (t) => {
  const { db, dao } = openTempDb(t);
  seedOneDay(dao);
  // 人为把聚合改错（模拟漂移）
  db.prepare('UPDATE daily_user SET sessions = 99, session_ms = 1, runs_done = 0, failures = 0, heartbeats = 1').run();
  db.prepare('UPDATE daily_tool SET sessions = 42, session_ms = 0').run();
  db.prepare('UPDATE daily_fail SET failures = 77').run();

  const r = runNightlyJob(dao, { nowFn });
  assert.strictEqual(r.ok, true);

  const row = db.prepare('SELECT * FROM daily_user').get();
  assert.strictEqual(row.sessions, 1);        // 复原
  assert.strictEqual(row.session_ms, 8000);
  assert.strictEqual(row.runs_done, 1);
  assert.strictEqual(row.failures, 1);
  assert.strictEqual(row.run_active_ms, 3000);
  assert.strictEqual(row.heartbeats, 1);      // ingest-only 列不动（events 无心跳，不可重算）

  const tool = db.prepare('SELECT * FROM daily_tool').get();
  assert.strictEqual(tool.sessions, 1);
  assert.strictEqual(tool.session_ms, 8000);

  const fail = db.prepare('SELECT * FROM daily_fail').get();
  assert.strictEqual(fail.failures, 1);       // 从 events 复原（77 → 1）
  assert.strictEqual(fail.kind, 'x');
});

test('缺行补建：有 events 无 daily 行 → 补出（heartbeats=0）', (t) => {
  const { db, dao } = openTempDb(t);
  // 绕过 ingest 直插原始事件（模拟历史漂移出的缺行）
  dao.insertEvent({ eventId: 'x1', installId: 'i9', user: 'u9', host: 'h9',
    type: 'session_start', clientTs: null, serverTs: NOW.toISOString(), day: TODAY,
    appVersion: '1.0.0', payload: '{"tool":"claude"}' });
  runNightlyJob(dao, { nowFn });
  const row = db.prepare('SELECT * FROM daily_user WHERE install_id = ?').get('i9');
  assert.strictEqual(row.sessions, 1);
  assert.strictEqual(row.heartbeats, 0);
});

test('清理边界：day == cutoff 保留、day < cutoff 删除；daily 行永久', (t) => {
  const { db, dao } = openTempDb(t);
  const retentionDays = 3;
  const cutoff = shiftDay(TODAY, -retentionDays);
  const mk = (id, day) => dao.insertEvent({ eventId: id, installId: 'i1', user: 'u', host: 'h',
    type: 'failure_event', clientTs: null, serverTs: day + 'T00:00:00.000Z', day,
    appVersion: null, payload: '{}' });
  mk('keep-today', TODAY);
  mk('keep-cutoff', cutoff);
  mk('drop-1', shiftDay(cutoff, -1));
  mk('drop-2', shiftDay(cutoff, -30));
  dao.bumpDaily(shiftDay(cutoff, -30), 'i1', 'u', 'h', { failures: 1 }); // 老 daily 行

  const r = runNightlyJob(dao, { nowFn, retentionDays });
  assert.strictEqual(r.deletedEvents, 2);
  const left = db.prepare('SELECT event_id FROM events ORDER BY event_id').all().map((x) => x.event_id);
  assert.deepStrictEqual(left, ['keep-cutoff', 'keep-today']);
  // 聚合表不受清理影响（永久保留）
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM daily_user WHERE day < ?').get(cutoff).c, 1);
});

test('hb_seen 按 7 天清理', (t) => {
  const { db, dao } = openTempDb(t);
  dao.markHbSeen('hb-old', shiftDay(TODAY, -8));
  dao.markHbSeen('hb-edge', shiftDay(TODAY, -7)); // == 边界日保留
  dao.markHbSeen('hb-new', TODAY);
  const r = runNightlyJob(dao, { nowFn });
  assert.strictEqual(r.deletedHb, 1);
  const left = db.prepare('SELECT event_id FROM hb_seen ORDER BY event_id').all().map((x) => x.event_id);
  assert.deepStrictEqual(left, ['hb-edge', 'hb-new']);
});

test('meta 记账：last_job_day / last_job_result', (t) => {
  const { dao } = openTempDb(t);
  runNightlyJob(dao, { nowFn });
  assert.strictEqual(dao.metaGet('last_job_day'), TODAY);
  assert.strictEqual(JSON.parse(dao.metaGet('last_job_result')).ok, true);
});

test('msUntilNextRun：2:59→1min、3:01→次日、整点→次日', () => {
  const at = (h, m) => new Date(2026, 6, 2, h, m, 0, 0);
  assert.strictEqual(msUntilNextRun(at(2, 59), 3), 60 * 1000);
  assert.strictEqual(msUntilNextRun(at(3, 1), 3), (24 * 60 - 1) * 60 * 1000);
  assert.strictEqual(msUntilNextRun(at(3, 0), 3), 24 * 60 * 60 * 1000);
});

test('启动补跑：上次成功日 != 今日才补跑', async (t) => {
  const { dao } = openTempDb(t);
  const calls = { n: 0 };
  const counted = { ...dao, recomputeDaily(d) { calls.n++; return dao.recomputeDaily(d); } };

  // 情形 1：meta 为空 → 补跑
  const s1 = startScheduler(counted, { nowFn, catchupDelayMs: 5 });
  t.after(() => s1.stop());
  await sleep(100);
  assert.strictEqual(calls.n, 1);
  assert.strictEqual(dao.metaGet('last_job_day'), TODAY);

  // 情形 2：今日已跑过 → 不补跑
  calls.n = 0;
  const s2 = startScheduler(counted, { nowFn, catchupDelayMs: 5 });
  t.after(() => s2.stop());
  await sleep(100);
  assert.strictEqual(calls.n, 0);
});

test('防重入：job 执行中再 fire 直接返回', (t) => {
  const { dao } = openTempDb(t);
  const calls = { n: 0 };
  let scheduler = null;
  const reentrant = { ...dao, recomputeDaily(d) {
    calls.n++;
    scheduler.fire(); // 执行中再触发：running 门直接弹回，不嵌套跑
    return dao.recomputeDaily(d);
  } };
  dao.metaSet('last_job_day', TODAY); // 关掉补跑，只测手动 fire
  scheduler = startScheduler(reentrant, { nowFn });
  t.after(() => scheduler.stop());
  scheduler.fire();
  assert.strictEqual(calls.n, 1);
});

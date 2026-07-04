'use strict';
// ingest.test.js —— 幂等门（坑 C 铁律 1）、心跳去重（坑 A）、day 时区固化（坑 B）、增量映射

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { openTempDb, listenApp, postJson, makeEvent } = require('./helpers');
const { ingestBatch, createIngestRouter } = require('../lib/ingest');
const { localDay } = require('../lib/time-utils');

const NOW = new Date('2026-07-02T03:00:00.000Z'); // 本地(+8) 2026-07-02 11:00

function dailyRow(db, day, installId) {
  return db.prepare('SELECT * FROM daily_user WHERE day = ? AND install_id = ?').get(day, installId);
}

test('正常批：accepted=N，events 落行，daily_user/daily_tool 增量正确', (t) => {
  const { db, dao } = openTempDb(t);
  const day = localDay(NOW);
  const r = ingestBatch(dao, [
    makeEvent({ type: 'instance_online', payload: { port: 5173, liveSessions: 0 } }),
    makeEvent({ type: 'session_start', payload: { tool: 'claude', cwdHash: 'abc' } }),
    makeEvent({ type: 'session_end', payload: { tool: 'claude', durationMs: 60000, exitCode: 0 } }),
    makeEvent({ type: 'bp_run_end', payload: { status: 'done', activeMs: 30000 } }),
    makeEvent({ type: 'bp_run_end', payload: { status: 'failed', activeMs: 1000 } }),
    makeEvent({ type: 'bp_run_end', payload: { status: 'halted', activeMs: 2000, haltReason: 'cap' } }),
    makeEvent({ type: 'failure_event', payload: { source: 'error_autoresume', kind: 'rate_limit' } }),
    makeEvent({ type: 'bp_run_start', payload: { blueprintId: 'bp1', runId: 'r1' } }),
  ], NOW);
  assert.deepStrictEqual(r, { accepted: 8, dup: 0, rejected: 0 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM events').get().c, 8);

  const row = dailyRow(db, day, 'inst-1');
  assert.strictEqual(row.sessions, 1);
  assert.strictEqual(row.session_ms, 60000);
  assert.strictEqual(row.runs_done, 1);
  assert.strictEqual(row.runs_failed, 1);
  assert.strictEqual(row.runs_halted, 1);
  assert.strictEqual(row.run_active_ms, 33000);
  assert.strictEqual(row.failures, 1);
  assert.strictEqual(row.heartbeats, 0);

  const tool = db.prepare('SELECT * FROM daily_tool WHERE tool = ?').get('claude');
  assert.strictEqual(tool.sessions, 1);         // 只有 session_start 计次
  assert.strictEqual(tool.session_ms, 60000);   // 时长来自 session_end

  // 失败维度日聚合：(day, appVersion, kind) 一行
  const fail = db.prepare('SELECT * FROM daily_fail').get();
  assert.strictEqual(fail.app_version, '1.4.0');
  assert.strictEqual(fail.kind, 'rate_limit');
  assert.strictEqual(fail.failures, 1);

  const inst = db.prepare('SELECT * FROM installs').get();
  assert.strictEqual(inst.install_id, 'inst-1');
  assert.strictEqual(inst.last_seen, NOW.toISOString());
});

test('同批重发：dup=N 且 daily_user 数值不变（幂等聚合核心）', (t) => {
  const { db, dao } = openTempDb(t);
  const batch = [
    makeEvent({ type: 'session_start', payload: { tool: 'claude' } }),
    makeEvent({ type: 'session_end', payload: { tool: 'claude', durationMs: 5000 } }),
    makeEvent({ type: 'failure_event', payload: { kind: 'x' } }),
  ];
  const r1 = ingestBatch(dao, batch, NOW);
  assert.deepStrictEqual(r1, { accepted: 3, dup: 0, rejected: 0 });
  const before = dailyRow(db, localDay(NOW), 'inst-1');

  const r2 = ingestBatch(dao, batch, NOW); // spool 补发场景：一模一样的整批
  assert.deepStrictEqual(r2, { accepted: 0, dup: 3, rejected: 0 });
  assert.deepStrictEqual(dailyRow(db, localDay(NOW), 'inst-1'), before);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM events').get().c, 3);
  const tool = db.prepare('SELECT * FROM daily_tool WHERE tool = ?').get('claude');
  assert.strictEqual(tool.sessions, 1);
  assert.strictEqual(tool.session_ms, 5000);
});

test('坏事件跳过（rejected 计数），其余照收', (t) => {
  const { db, dao } = openTempDb(t);
  const r = ingestBatch(dao, [
    makeEvent({ type: 'session_start' }),
    makeEvent({ eventId: '' }),                    // 空 eventId
    makeEvent({ schemaVersion: 2 }),               // 版本不符
    { foo: 'bar' },                                // 非信封
    null,                                          // 空值
    makeEvent({ user: undefined }),                // 缺 user
  ], NOW);
  assert.deepStrictEqual(r, { accepted: 1, dup: 0, rejected: 5 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
});

test('failure 缺 kind/version：归一为 unknown（daily_fail PK 无 NULL）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'failure_event', appVersion: undefined, payload: { source: 'halt' } }), // 无 kind、无 version
    makeEvent({ type: 'failure_event', payload: { kind: '' } }),                               // 空 kind
  ], NOW);
  const rows = db.prepare('SELECT app_version, kind, failures FROM daily_fail ORDER BY app_version').all();
  // 一条 (unknown, unknown)，一条 (1.4.0, unknown)
  assert.deepStrictEqual(rows, [
    { app_version: '1.4.0', kind: 'unknown', failures: 1 },
    { app_version: 'unknown', kind: 'unknown', failures: 1 },
  ]);
});

test('未知 type（v2 前向兼容）：落 events 原始行，不做任何聚合', (t) => {
  const { db, dao } = openTempDb(t);
  const r = ingestBatch(dao, [
    makeEvent({ type: 'ticket', payload: { ticketId: 't1', title: 'x' } }),
  ], NOW);
  assert.deepStrictEqual(r, { accepted: 1, dup: 0, rejected: 0 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
  const row = dailyRow(db, localDay(NOW), 'inst-1');
  assert.strictEqual(row, undefined); // 无聚合痕迹
  // 但 installs 已注册（未知 type 也刷新 last_seen——实例活着这一事实与 type 无关）
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM installs').get().c, 1);
});

test('心跳：不落 events；首发 bump、重发 dup 不变（坑 A）', (t) => {
  const { db, dao } = openTempDb(t);
  const hb = makeEvent({ type: 'instance_heartbeat', payload: { liveSessions: 2 } });
  const r1 = ingestBatch(dao, [hb], NOW);
  assert.deepStrictEqual(r1, { accepted: 1, dup: 0, rejected: 0 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM events').get().c, 0); // 不落原始表
  assert.strictEqual(dailyRow(db, localDay(NOW), 'inst-1').heartbeats, 1);
  assert.strictEqual(db.prepare('SELECT live_sessions v FROM installs').get().v, 2);

  const r2 = ingestBatch(dao, [hb], NOW); // spool 重发同一心跳
  assert.deepStrictEqual(r2, { accepted: 0, dup: 1, rejected: 0 });
  assert.strictEqual(dailyRow(db, localDay(NOW), 'inst-1').heartbeats, 1); // 不双计
});

test('day 归属：以服务器本地日固化（坑 B）', (t) => {
  const { db, dao } = openTempDb(t);
  const lateUtc = new Date('2026-07-01T16:30:00.000Z'); // +8 时区 = 本地 2026-07-02 00:30
  ingestBatch(dao, [makeEvent({ type: 'session_start' })], lateUtc);
  const row = db.prepare('SELECT day, server_ts FROM events').get();
  assert.strictEqual(row.day, localDay(lateUtc));       // 存的是本地日，不是 ISO substr
  if (lateUtc.getTimezoneOffset() === -480) {           // 在 +8 机器上明确断言跨日
    assert.strictEqual(row.day, '2026-07-02');
    assert.notStrictEqual(row.day, row.server_ts.slice(0, 10)); // 与 UTC 日不同
  }
});

test('ms 净化：负数/非数值按 0 计（与夜间补算同口径）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'session_end', payload: { tool: 'x', durationMs: -5000 } }),
    makeEvent({ type: 'session_end', payload: { tool: 'x', durationMs: 'abc' } }),
    makeEvent({ type: 'bp_run_end', payload: { status: 'done', activeMs: null } }),
  ], NOW);
  const row = dailyRow(db, localDay(NOW), 'inst-1');
  assert.strictEqual(row.session_ms, 0);
  assert.strictEqual(row.run_active_ms, 0);
  assert.strictEqual(row.runs_done, 1);
});

test('HTTP 路由：>500 批与非数组 → 400；正常批 → {ok,accepted,dup}', async (t) => {
  const { dao } = openTempDb(t);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', createIngestRouter(dao, { nowFn: () => NOW }));
  const { baseUrl } = await listenApp(t, app);

  const big = { events: Array.from({ length: 501 }, () => makeEvent({})) };
  assert.strictEqual((await postJson(baseUrl, '/v1/events', big)).status, 400);
  assert.strictEqual((await postJson(baseUrl, '/v1/events', { events: 'nope' })).status, 400);
  assert.strictEqual((await postJson(baseUrl, '/v1/events', {})).status, 400);

  const ok = await postJson(baseUrl, '/v1/events', { events: [makeEvent({})] });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.ok, true);
  assert.strictEqual(ok.json.accepted, 1);
  assert.strictEqual(ok.json.dup, 0);
});

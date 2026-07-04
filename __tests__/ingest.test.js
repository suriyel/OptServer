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

test('空批 → accepted 0（不报错，spool 空刷）', (t) => {
  const { dao } = openTempDb(t);
  assert.deepStrictEqual(ingestBatch(dao, [], NOW), { accepted: 0, dup: 0, rejected: 0 });
});

test('恰好 500 批放行（边界，>500 才拒）', async (t) => {
  const { dao } = openTempDb(t);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/v1', createIngestRouter(dao, { nowFn: () => NOW }));
  const { baseUrl } = await listenApp(t, app);
  const batch = { events: Array.from({ length: 500 }, (_, i) => makeEvent({ eventId: 'e' + i })) };
  const r = await postJson(baseUrl, '/v1/events', batch);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.accepted, 500);
});

test('同批内重复 eventId → 第二条 dup（同事务幂等门）', (t) => {
  const { db, dao } = openTempDb(t);
  const r = ingestBatch(dao, [
    makeEvent({ eventId: 'same', type: 'session_start' }),
    makeEvent({ eventId: 'same', type: 'session_start' }),
  ], NOW);
  assert.deepStrictEqual(r, { accepted: 1, dup: 1, rejected: 0 });
  assert.strictEqual(dailyRow(db, localDay(NOW), 'inst-1').sessions, 1); // 不双计
});

test('bp_run_end 非法 status → 三 runs 列均 0，run_active_ms 仍累加', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'bp_run_end', payload: { status: 'weird', activeMs: 7000 } }),
  ], NOW);
  const row = dailyRow(db, localDay(NOW), 'inst-1');
  assert.strictEqual(row.runs_done + row.runs_failed + row.runs_halted, 0);
  assert.strictEqual(row.run_active_ms, 7000);
});

test('bp_run_start：只落 events，不 bump daily（run 计数以终态为准）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'bp_run_start', payload: { blueprintId: 'bp1', runId: 'r1', tool: 'claude' } }),
  ], NOW);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
  assert.strictEqual(dailyRow(db, localDay(NOW), 'inst-1'), undefined); // 无聚合行
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM daily_tool').get().c, 0);
});

test('instance_online：刷 installs.live_sessions + 建当日行（计数 0）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'instance_online', payload: { port: 5173, liveSessions: 5 } }),
  ], NOW);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1); // online 落 events
  assert.strictEqual(db.prepare('SELECT live_sessions v FROM installs').get().v, 5);
  const row = dailyRow(db, localDay(NOW), 'inst-1');
  assert.strictEqual(row.sessions, 0); // 建行但计数 0（DAU 兜底）
  assert.strictEqual(row.heartbeats, 0);
});

test('超长字段被拒：eventId>128 / type>64 / user>256', (t) => {
  const { dao } = openTempDb(t);
  const r = ingestBatch(dao, [
    makeEvent({ eventId: 'x'.repeat(129) }),
    makeEvent({ type: 'y'.repeat(65) }),
    makeEvent({ user: 'z'.repeat(257) }),
    makeEvent({}), // 一条合法
  ], NOW);
  assert.deepStrictEqual(r, { accepted: 1, dup: 0, rejected: 3 });
});

test('schemaVersion 严格 === 1：字符串 "1" 被拒', (t) => {
  const { dao } = openTempDb(t);
  const r = ingestBatch(dao, [makeEvent({ schemaVersion: '1' })], NOW);
  assert.deepStrictEqual(r, { accepted: 0, dup: 0, rejected: 1 });
});

test('payload 缺失（undefined）不崩，events.payload 落 {}', (t) => {
  const { db, dao } = openTempDb(t);
  const r = ingestBatch(dao, [makeEvent({ type: 'session_start', payload: undefined })], NOW);
  assert.strictEqual(r.accepted, 1);
  assert.strictEqual(db.prepare('SELECT payload FROM events').get().payload, '{}');
});

test('路由层 ingestBatch 抛异常 → 500 { ok:false }（fail-safe，不裸崩）', async (t) => {
  const boomDao = { txIngest() { throw new Error('boom'); } };
  const app = express();
  app.use(express.json());
  app.use('/v1', createIngestRouter(boomDao, { nowFn: () => NOW }));
  const { baseUrl } = await listenApp(t, app);
  const r = await postJson(baseUrl, '/v1/events', { events: [makeEvent({})] });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.json.ok, false);
});

// ---- v0.2.0：token / 工作流归因 / 用户中断 ----

function bpRow(db, day, bp) {
  return db.prepare('SELECT * FROM daily_blueprint WHERE day = ? AND blueprint_id = ?').get(day, bp);
}

test('session_end token → daily_user.in/out_tokens（总量权威）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'session_end', payload: { tool: 'claude', durationMs: 1000, inputTokens: 1200, outputTokens: 340 } }),
  ], NOW);
  const row = dailyRow(db, localDay(NOW), 'inst-1');
  assert.strictEqual(row.in_tokens, 1200);
  assert.strictEqual(row.out_tokens, 340);
});

test('bp_run_end token 只进 daily_blueprint，不进 daily_user（防双计核心）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'bp_run_end', payload: { blueprintId: 'bp-A', runId: 'r1', status: 'done',
      activeMs: 5000, interruptions: 2, inputTokens: 900, outputTokens: 100 } }),
  ], NOW);
  // daily_user：run 计数与 activeMs 照常，但 token 保持 0（run token 不计入总量）
  const u = dailyRow(db, localDay(NOW), 'inst-1');
  assert.strictEqual(u.runs_done, 1);
  assert.strictEqual(u.run_active_ms, 5000);
  assert.strictEqual(u.in_tokens, 0);
  assert.strictEqual(u.out_tokens, 0);
  // daily_blueprint：归因到 bp-A
  const b = bpRow(db, localDay(NOW), 'bp-A');
  assert.strictEqual(b.runs_done, 1);
  assert.strictEqual(b.active_ms, 5000);
  assert.strictEqual(b.interruptions, 2);
  assert.strictEqual(b.in_tokens, 900);
  assert.strictEqual(b.out_tokens, 100);
});

test('bp_run_end 三终态 + 中断/activeMs 累加到工作流', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'bp_run_end', payload: { blueprintId: 'bp-A', status: 'done', activeMs: 1000, interruptions: 1 } }),
    makeEvent({ type: 'bp_run_end', payload: { blueprintId: 'bp-A', status: 'failed', activeMs: 2000, interruptions: 3 } }),
    makeEvent({ type: 'bp_run_end', payload: { blueprintId: 'bp-B', status: 'halted', activeMs: 500 } }),
  ], NOW);
  const a = bpRow(db, localDay(NOW), 'bp-A');
  assert.strictEqual(a.runs_done, 1);
  assert.strictEqual(a.runs_failed, 1);
  assert.strictEqual(a.active_ms, 3000);
  assert.strictEqual(a.interruptions, 4);
  const b = bpRow(db, localDay(NOW), 'bp-B');
  assert.strictEqual(b.runs_halted, 1);
});

test('failure_event 带 blueprintId → daily_blueprint.failures；不带则不归因工作流', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'failure_event', payload: { kind: 'rate_limit', blueprintId: 'bp-A' } }),
    makeEvent({ type: 'failure_event', payload: { kind: 'auth' } }), // 无 blueprintId
  ], NOW);
  // 归因的落 daily_blueprint
  assert.strictEqual(bpRow(db, localDay(NOW), 'bp-A').failures, 1);
  // 全部仍计入 daily_user.failures 与 daily_fail（总量不受工作流归因影响）
  assert.strictEqual(dailyRow(db, localDay(NOW), 'inst-1').failures, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM daily_blueprint').get().c, 1); // 只有 bp-A
});

test('bp_run_start 不归因工作流（run 计数以终态为准）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'bp_run_start', payload: { blueprintId: 'bp-A', runId: 'r1', tool: 'claude' } }),
  ], NOW);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM daily_blueprint').get().c, 0);
});

test('token 负数/非数 → 0（净化，防夜间补算把垃圾补回）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [
    makeEvent({ type: 'session_end', payload: { durationMs: 1000, inputTokens: -5, outputTokens: 'x' } }),
    makeEvent({ type: 'bp_run_end', payload: { blueprintId: 'bp-A', status: 'done', inputTokens: NaN, interruptions: -1 } }),
  ], NOW);
  const u = dailyRow(db, localDay(NOW), 'inst-1');
  assert.strictEqual(u.in_tokens, 0);
  assert.strictEqual(u.out_tokens, 0);
  const b = bpRow(db, localDay(NOW), 'bp-A');
  assert.strictEqual(b.in_tokens, 0);
  assert.strictEqual(b.interruptions, 0);
});

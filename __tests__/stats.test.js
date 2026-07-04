'use strict';
// stats.test.js —— 7 个查询端点：固定种子数据逐字段断言 + 范围解析 + 在线边界 + WAU 滑窗

const test = require('node:test');
const assert = require('node:assert');

const { makeApp, getJson, makeEvent } = require('./helpers');
const { ingestBatch } = require('../lib/ingest');
const { parseRange, shiftDay } = require('../lib/stats');
const { localDay } = require('../lib/time-utils');

// 用本地时间构造，保证任何 TZ 机器上 localDay 都是期望日
const NOW = new Date(2026, 6, 2, 12, 0, 0);   // 本地 2026-07-02 12:00
const D1 = new Date(2026, 5, 30, 12, 0, 0);   // 2026-06-30
const D2 = new Date(2026, 6, 1, 12, 0, 0);    // 2026-07-01

const A = { installId: 'inst-A', user: 'userA', host: 'HOST-A', appVersion: '1.4.0' };
const B = { installId: 'inst-B', user: 'userB', host: 'HOST-B', appVersion: '1.3.0' };

// 三天种子：D1 = A 一次完整会话 + B 心跳；D2 = A run 完成 + A 失败 + B 会话；D3(今天) = A 心跳 + A 开会话
function seed(dao, db) {
  ingestBatch(dao, [
    makeEvent({ ...A, type: 'session_start', payload: { tool: 'claude' } }),
    makeEvent({ ...A, type: 'session_end', payload: { tool: 'claude', durationMs: 10000 } }),
    makeEvent({ ...B, type: 'instance_heartbeat', payload: { liveSessions: 1 } }),
  ], D1);
  ingestBatch(dao, [
    makeEvent({ ...A, type: 'bp_run_end', payload: { status: 'done', activeMs: 5000 } }),
    makeEvent({ ...A, type: 'failure_event', payload: { source: 'error_autoresume', kind: 'rate_limit' } }),
    makeEvent({ ...B, type: 'session_start', payload: { tool: 'codex' } }),
  ], D2);
  ingestBatch(dao, [
    makeEvent({ ...A, type: 'instance_heartbeat', payload: { liveSessions: 2 } }),
    makeEvent({ ...A, type: 'session_start', payload: { tool: 'claude' } }),
  ], NOW);
  // 在线边界：A = 9 分钟前（在线），B = 11 分钟前（离线）
  const upd = db.prepare('UPDATE installs SET last_seen = ? WHERE install_id = ?');
  upd.run(new Date(NOW.getTime() - 9 * 60 * 1000).toISOString(), 'inst-A');
  upd.run(new Date(NOW.getTime() - 11 * 60 * 1000).toISOString(), 'inst-B');
}

async function seededApp(t) {
  const h = await makeApp(t, { nowFn: () => NOW });
  seed(h.dao, h.db);
  return h;
}

test('overview：今日/周活跃、在线边界(<10min)、今日总量', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { status, json } = await getJson(baseUrl, '/v1/stats/overview');
  assert.strictEqual(status, 200);
  const d = json.data;
  assert.strictEqual(d.today, localDay(NOW));
  assert.strictEqual(d.activeUsersToday, 1);  // 今日仅 A 活跃
  assert.strictEqual(d.activeUsersWeek, 2);   // 7 天内 A、B 都活跃
  assert.strictEqual(d.onlineInstalls, 1);    // 9min 计入、11min 不计
  assert.strictEqual(d.sessionsToday, 1);
  assert.strictEqual(d.runsToday, 0);
  assert.strictEqual(d.failuresToday, 0);
});

test('dau：逐日 DAU/会话/时长 + WAU 滑窗（左扩 6 天参与）', async (t) => {
  const { baseUrl } = await seededApp(t);
  const from = localDay(D1), to = localDay(NOW);
  const { json } = await getJson(baseUrl, `/v1/stats/dau?from=${from}&to=${to}`);
  const days = json.data.days;
  assert.strictEqual(days.length, 3);
  assert.deepStrictEqual(days.map((x) => x.dau), [2, 2, 1]);      // 心跳也算日活（daily 行存在）
  assert.deepStrictEqual(days.map((x) => x.sessions), [1, 1, 1]);
  assert.deepStrictEqual(days.map((x) => x.sessionMs), [10000, 0, 0]);
  assert.strictEqual(days[2].wau, 2);                             // 今日 WAU 并集含 D1/D2 的 B
});

test('dau：缺省范围 = 近 30 天', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { json } = await getJson(baseUrl, '/v1/stats/dau');
  assert.strictEqual(json.data.days.length, 30);
  assert.strictEqual(json.data.to, localDay(NOW));
});

test('versions：按 install 最新版本分布', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { json } = await getJson(baseUrl, '/v1/stats/versions');
  const map = new Map(json.data.versions.map((v) => [v.version, v]));
  assert.strictEqual(map.get('1.4.0').installs, 1);
  assert.strictEqual(map.get('1.3.0').installs, 1);
  assert.strictEqual(map.size, 2);
});

test('tools：工具会话数与时长（走 daily_tool）', async (t) => {
  const { baseUrl } = await seededApp(t);
  const from = localDay(D1), to = localDay(NOW);
  const { json } = await getJson(baseUrl, `/v1/stats/tools?from=${from}&to=${to}`);
  const map = new Map(json.data.tools.map((x) => [x.tool, x]));
  assert.strictEqual(map.get('claude').sessions, 2);
  assert.strictEqual(map.get('claude').sessionMs, 10000);
  assert.strictEqual(map.get('codex').sessions, 1);
});

test('runs：逐日终态分布与 activeMs', async (t) => {
  const { baseUrl } = await seededApp(t);
  const from = localDay(D1), to = localDay(NOW);
  const { json } = await getJson(baseUrl, `/v1/stats/runs?from=${from}&to=${to}`);
  const days = json.data.days;
  assert.deepStrictEqual(days.map((x) => x.done), [0, 1, 0]);
  assert.deepStrictEqual(days.map((x) => x.activeMs), [0, 5000, 0]);
});

test('failures：kind 分布、按版本失败率、最近列表', async (t) => {
  const { baseUrl } = await seededApp(t);
  const from = localDay(D1), to = localDay(NOW);
  const { json } = await getJson(baseUrl, `/v1/stats/failures?from=${from}&to=${to}`);
  const d = json.data;
  assert.deepStrictEqual(d.kinds, [{ kind: 'rate_limit', n: 1 }]);
  assert.deepStrictEqual(d.byVersion, [{ version: '1.4.0', failures: 1, runs: 1, rate: 1 }]);
  assert.strictEqual(d.recent.length, 1);
  assert.strictEqual(d.recent[0].user, 'userA');
  assert.strictEqual(d.recent[0].payload.kind, 'rate_limit');
});

test('failures recent：按 day DESC, server_ts DESC 倒序（最新在前）', async (t) => {
  const { baseUrl, dao } = await makeApp(t, { nowFn: () => NOW });
  // 三天各一条失败，用不同 install 避免聚合覆盖
  ingestBatch(dao, [makeEvent({ ...A, type: 'failure_event', payload: { kind: 'old' } })], D1);
  ingestBatch(dao, [makeEvent({ ...A, type: 'failure_event', payload: { kind: 'mid' } })], D2);
  ingestBatch(dao, [makeEvent({ ...A, type: 'failure_event', payload: { kind: 'new' } })], NOW);
  const { json } = await getJson(baseUrl, `/v1/stats/failures?from=${localDay(D1)}&to=${localDay(NOW)}`);
  assert.deepStrictEqual(json.data.recent.map((r) => r.payload.kind), ['new', 'mid', 'old']);
});

test('installs：明细按 last_seen 倒序', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { json } = await getJson(baseUrl, '/v1/installs');
  const list = json.data.installs;
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].installId, 'inst-A'); // 9min 前 > 11min 前
  assert.strictEqual(list[1].installId, 'inst-B');
  assert.strictEqual(list[0].liveSessions, 2);
});

test('范围解析：非法/倒置 → 400；parseRange 纯函数边界', async (t) => {
  const { baseUrl } = await seededApp(t);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/dau?from=bad')).status, 400);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/dau?from=2026-07-02&to=2026-07-01')).status, 400);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/runs?from=2020-01-01&to=2026-07-02')).status, 400); // >400 天

  assert.deepStrictEqual(parseRange({}, NOW), { from: shiftDay(localDay(NOW), -29), to: localDay(NOW) });
  assert.strictEqual(parseRange({ from: '2026-7-1' }, NOW), null); // 必须补零
});

// ---- v0.2.0：token / 用户 Top / 工作流 ----

const from = localDay(D1), to = localDay(NOW);

// A：2 会话(token 1000/300 + 500/100)、1 done run；B：1 会话、1 failed run
function seedV2(dao) {
  ingestBatch(dao, [
    makeEvent({ ...A, type: 'session_end', payload: { tool: 'claude', durationMs: 10000, inputTokens: 1000, outputTokens: 300 } }),
    makeEvent({ ...A, type: 'session_end', payload: { tool: 'claude', durationMs: 5000, inputTokens: 500, outputTokens: 100 } }),
    makeEvent({ ...A, type: 'bp_run_end', payload: { blueprintId: 'ship-it', status: 'done', activeMs: 8000, interruptions: 2, inputTokens: 700, outputTokens: 90 } }),
  ], D2);
  ingestBatch(dao, [
    makeEvent({ ...B, type: 'session_end', payload: { tool: 'codex', durationMs: 2000, inputTokens: 200, outputTokens: 50 } }),
    makeEvent({ ...B, type: 'bp_run_end', payload: { blueprintId: 'ship-it', status: 'failed', activeMs: 1000, interruptions: 5 } }),
    makeEvent({ ...B, type: 'failure_event', payload: { kind: 'oom', blueprintId: 'ship-it' } }),
  ], NOW);
}

test('overview / dau：token 字段（总量来自 session_end）', async (t) => {
  const h = await makeApp(t, { nowFn: () => NOW });
  seedV2(h.dao);
  const ov = (await getJson(h.baseUrl, '/v1/stats/overview')).json.data;
  assert.strictEqual(ov.inTokensToday, 200);   // 今日仅 B 的 session_end
  assert.strictEqual(ov.outTokensToday, 50);
  const dau = (await getJson(h.baseUrl, `/v1/stats/dau?from=${from}&to=${to}`)).json.data;
  const d2 = dau.days.find((x) => x.day === localDay(D2));
  assert.strictEqual(d2.inTokens, 1500);        // A 两会话 1000+500
  assert.strictEqual(d2.outTokens, 400);
});

test('users/top：按 metric 排序 + limit + 非法 metric 400', async (t) => {
  const h = await makeApp(t, { nowFn: () => NOW });
  seedV2(h.dao);
  // 按 token 排序：A(1900=1500in+400out) > B(250)
  const byTok = (await getJson(h.baseUrl, `/v1/stats/users/top?from=${from}&to=${to}&metric=tokens`)).json.data;
  assert.strictEqual(byTok.metric, 'tokens');
  assert.strictEqual(byTok.users[0].user, 'userA');
  assert.strictEqual(byTok.users[0].tokens, 1900);
  assert.strictEqual(byTok.users[1].user, 'userB');
  // limit=1 只回 1 条
  const lim = (await getJson(h.baseUrl, `/v1/stats/users/top?from=${from}&to=${to}&metric=sessions&limit=1`)).json.data;
  assert.strictEqual(lim.users.length, 1);
  // 非法 metric → 400
  assert.strictEqual((await getJson(h.baseUrl, `/v1/stats/users/top?metric=drop`)).status, 400);
});

test('blueprints：runs/失败归因/activeMs/中断/token', async (t) => {
  const h = await makeApp(t, { nowFn: () => NOW });
  seedV2(h.dao);
  const { json } = await getJson(h.baseUrl, `/v1/stats/blueprints?from=${from}&to=${to}`);
  const bp = json.data.blueprints.find((x) => x.blueprintId === 'ship-it');
  assert.strictEqual(bp.runsDone, 1);
  assert.strictEqual(bp.runsFailed, 1);
  assert.strictEqual(bp.runs, 2);
  assert.strictEqual(bp.failures, 1);        // failure_event 带 blueprintId 归因
  assert.strictEqual(bp.activeMs, 9000);     // 8000 + 1000
  assert.strictEqual(bp.interruptions, 7);   // 2 + 5
  assert.strictEqual(bp.tokens, 790);        // 仅 done run 带 token(700+90)
});

test('failures recent：带 blueprintId（失败对应工作流）', async (t) => {
  const h = await makeApp(t, { nowFn: () => NOW });
  seedV2(h.dao);
  const { json } = await getJson(h.baseUrl, `/v1/stats/failures?from=${from}&to=${to}`);
  assert.strictEqual(json.data.recent[0].payload.blueprintId, 'ship-it');
});

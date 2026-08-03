'use strict';
// stats-trend.test.js —— P1 时间维度：环比对比窗（两端不含当日）+ 单实体逐日序列端点。
//
// 关键断言是「今日被排除在环比之外」：种子刻意在今天也放活动，若窗口算错，
// cur 会把今天算进去，下面的 runs 断言立刻破——这是整套环比可信度的锚点。

const test = require('node:test');
const assert = require('node:assert');

const { makeApp, getJson, makeEvent } = require('./helpers');
const { compareWindows } = require('../lib/stats');
const { localDay } = require('../lib/time-utils');

const NOW = new Date(2026, 6, 2, 12, 0, 0);   // 本地 2026-07-02 12:00（今天）
const D_PREV = new Date(2026, 4, 20, 12, 0, 0); // 2026-05-20：落在上期窗
const D_CUR = new Date(2026, 5, 15, 12, 0, 0);  // 2026-06-15：落在本期窗（也在 range 内）

const A = { installId: 'inst-A', user: 'userA', host: 'HOST-A', appVersion: '1.4.0' };
// 同一 user@host 的第二个实例（多 DATA_ROOT）：用户序列必须按天合并，不能拆成两行
const A2 = { installId: 'inst-A2', user: 'userA', host: 'HOST-A', appVersion: '1.4.0' };

const BP = 'bp-alpha';

function runEnd(over) {
  return makeEvent({ ...A, type: 'bp_run_end',
    payload: { status: 'done', blueprintId: BP, activeMs: 1000, inputTokens: 10, outputTokens: 5 }, ...over });
}

// 上期 2 个 run、本期 5 个、今天 3 个（今天只进 range 总量，不该进 cur）
function seed(dao) {
  const { ingestBatch } = require('../lib/ingest');
  const emit = (n, when) => ingestBatch(dao, Array.from({ length: n }, () => runEnd()), when);
  emit(2, D_PREV);
  emit(5, D_CUR);
  emit(3, NOW);
  // 会话：本期两个实例各一条（同一 user@host），今天一条
  ingestBatch(dao, [
    makeEvent({ ...A, type: 'session_start', payload: { tool: 'claude' } }),
    makeEvent({ ...A2, type: 'session_start', payload: { tool: 'claude' } }),
  ], D_CUR);
  ingestBatch(dao, [makeEvent({ ...A, type: 'session_start', payload: { tool: 'claude' } })], NOW);
}

async function seededApp(t) {
  const h = await makeApp(t, { nowFn: () => NOW });
  seed(h.dao);
  return h;
}

// ---- 纯函数 ----

test('compareWindows：缺省 30 天 → 本期/上期各 30 完整天、均截至昨日', () => {
  const w = compareWindows({ from: '2026-06-03', to: '2026-07-02' }, NOW);
  assert.deepStrictEqual(w.cur, { from: '2026-06-02', to: '2026-07-01' });
  assert.deepStrictEqual(w.prev, { from: '2026-05-03', to: '2026-06-01' });
});

test('compareWindows：7 天档同样两端不含当日', () => {
  const w = compareWindows({ from: '2026-06-26', to: '2026-07-02' }, NOW);
  assert.deepStrictEqual(w.cur, { from: '2026-06-25', to: '2026-07-01' });
  assert.deepStrictEqual(w.prev, { from: '2026-06-18', to: '2026-06-24' });
});

test('compareWindows：显式历史区间（to<今天）本期即 range 自身，上期为紧邻等长窗', () => {
  const w = compareWindows({ from: '2026-05-01', to: '2026-05-10' }, NOW);
  assert.deepStrictEqual(w.cur, { from: '2026-05-01', to: '2026-05-10' });
  assert.deepStrictEqual(w.prev, { from: '2026-04-21', to: '2026-04-30' });
});

test('compareWindows：range 内无完整自然日（仅今天）→ null，不硬凑环比', () => {
  assert.strictEqual(compareWindows({ from: '2026-07-02', to: '2026-07-02' }, NOW), null);
});

// ---- 工作流：列表 cur/prev ----

test('blueprints：总量含今日，但环比 cur 不含 —— 8 = 5+3 而 cur.runs = 5', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { json } = await getJson(baseUrl, '/v1/stats/blueprints');
  const d = json.data;
  assert.deepStrictEqual(d.compare.cur, { from: '2026-06-02', to: '2026-07-01' });
  const bp = d.blueprints.find((x) => x.blueprintId === BP);
  assert.strictEqual(bp.runs, 8);        // range=[06-03..07-02]：本期 5 + 今天 3
  assert.strictEqual(bp.cur.runs, 5);    // 今天被排除
  assert.strictEqual(bp.prev.runs, 2);   // 上期窗 05-20 的 2 个
  assert.strictEqual(bp.cur.tokens, 5 * 15);
  assert.strictEqual(bp.prev.tokens, 2 * 15);
});

test('blueprints：range 内无完整日时 compare=null 且不带 cur/prev', async (t) => {
  const { baseUrl } = await seededApp(t);
  const today = localDay(NOW);
  const { json } = await getJson(baseUrl, `/v1/stats/blueprints?from=${today}&to=${today}`);
  assert.strictEqual(json.data.compare, null);
  assert.strictEqual(json.data.blueprints[0].cur, undefined);
});

// ---- 工作流：逐日序列 ----

test('blueprints/series：缺省 30 天逐日补零，命中日数值正确', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { json } = await getJson(baseUrl, `/v1/stats/blueprints/series?id=${BP}`);
  const days = json.data.days;
  assert.strictEqual(days.length, 30);
  assert.strictEqual(days[0].day, '2026-06-03');
  assert.strictEqual(days[days.length - 1].day, '2026-07-02');
  assert.strictEqual(days.find((x) => x.day === '2026-06-15').runsDone, 5);
  assert.strictEqual(days.find((x) => x.day === '2026-07-02').runsDone, 3);
  assert.strictEqual(days.find((x) => x.day === '2026-06-20').runsDone, 0); // 空日补零而非缺行
  assert.strictEqual(days.reduce((s, x) => s + x.runsDone, 0), 8);
});

test('blueprints/series：id 缺失/空 → 400；未知 id → 全零序列（非 404）', async (t) => {
  const { baseUrl } = await seededApp(t);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/blueprints/series')).status, 400);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/blueprints/series?id=')).status, 400);
  const { status, json } = await getJson(baseUrl, '/v1/stats/blueprints/series?id=bp-nope');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.data.days.length, 30);
  assert.strictEqual(json.data.days.reduce((s, x) => s + x.runsDone, 0), 0);
});

test('blueprints/series：非法 range → 400（复用 parseRange 口径）', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { status } = await getJson(baseUrl, `/v1/stats/blueprints/series?id=${BP}&from=2026-07-05&to=2026-07-01`);
  assert.strictEqual(status, 400);
});

// ---- 用户：列表 cur/prev + 逐日序列 ----

test('users/top：带 compare 与每行 cur/prev，今日会话不进 cur', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { json } = await getJson(baseUrl, '/v1/stats/users/top');
  const d = json.data;
  assert.deepStrictEqual(d.compare.prev, { from: '2026-05-03', to: '2026-06-01' });
  const u = d.users.find((x) => x.user === 'userA' && x.host === 'HOST-A');
  assert.strictEqual(u.sessions, 3);      // range 内：本期 2 + 今天 1
  assert.strictEqual(u.cur.sessions, 2);  // 今天被排除
  assert.strictEqual(u.cur.runs, 5);
  assert.strictEqual(u.prev.runs, 2);
});

test('users/series：同一 user@host 的多个 install_id 按天合并成一行', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { json } = await getJson(baseUrl, '/v1/stats/users/series?user=userA&host=HOST-A');
  const days = json.data.days;
  assert.strictEqual(days.length, 30);
  const cur = days.find((x) => x.day === '2026-06-15');
  assert.strictEqual(cur.sessions, 2);    // inst-A + inst-A2 合并，而非两行各 1
  assert.strictEqual(cur.runsDone, 5);
  assert.strictEqual(days.find((x) => x.day === '2026-07-02').sessions, 1);
});

test('users/series：user/host 任一缺失 → 400', async (t) => {
  const { baseUrl } = await seededApp(t);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/users/series?user=userA')).status, 400);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/users/series?host=HOST-A')).status, 400);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/users/series')).status, 400);
});

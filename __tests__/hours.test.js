'use strict';
// hours.test.js —— P3 使用时段分布（作息）。三条写路径（ingest / 夜间重算 / 回填）同口径，
// 加上这一期特有的两个坑：**不合格事件是丢弃而非回落**、**全局行 ≠ 各工作流行之和**。

const test = require('node:test');
const assert = require('node:assert');

const { openTempDb, makeApp, getJson } = require('./helpers');
const { ingestBatch, hourBucketOf } = require('../lib/ingest');
const { runNightlyJob } = require('../lib/aggregate');
const { localDay, shiftDay } = require('../lib/time-utils');

const A = { schemaVersion: 1, installId: 'i1', user: 'u1', host: 'h1', appVersion: '1.0.0' };
const ev = (over) => Object.assign({}, A, over);
const hoursOf = (db, bp) => db.prepare(
  'SELECT day, hour, events, sessions, runs FROM daily_hour WHERE blueprint_id = ? ORDER BY day, hour').all(bp == null ? '' : bp);

// 本地时刻构造：保证 hourBucketOf 与断言用的是同一个时区语义
const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi || 0, 0);

// ---- 口径对拍：JS 与 SQL ----

test('时段分桶：JS 与 SQL 对同一批输入逐例一致（含带偏移/跨午夜/丢弃三种）', (t) => {
  const now = at(2026, 7, 3, 20, 0);
  const cases = [
    ['2026-08-03T01:30:00.000Z', now.toISOString(), '正常 UTC'],
    ['2026-08-03T09:30:00+08:00', now.toISOString(), '带偏移'],
    ['2026-08-03T23:45:00.000Z', now.toISOString(), '跨 UTC 午夜'],
    [null, now.toISOString(), 'ts 缺失 → 丢弃'],
    ['not-a-date', now.toISOString(), '不可解析 → 丢弃'],
    [new Date(now.getTime() + 3600e3).toISOString(), now.toISOString(), '未来 1h → 丢弃'],
    ['2026-07-01T12:00:00.000Z', now.toISOString(), '早 1 月（补发）'],
  ];
  for (const [clientTs, serverTs, label] of cases) {
    const h = openTempDb(t);
    h.db.prepare(`INSERT INTO events (event_id, install_id, user, host, type, client_ts, server_ts, day, payload)
      VALUES ('x', 'i1', 'u', 'h', 'session_start', ?, ?, ?, '{}')`)
      .run(clientTs, serverTs, localDay(now));
    // SQL 侧：走夜间重算那段（窗口开到很早，保证不被 fromDay 过滤掉）
    h.dao.recomputeDailyHour('2000-01-01');
    const sqlRows = hoursOf(h.db, '');
    const js = hourBucketOf({ ts: clientTs }, now.getTime());
    if (js == null) {
      assert.strictEqual(sqlRows.length, 0, label + '：JS 判丢弃，SQL 也必须不入桶');
    } else {
      assert.strictEqual(sqlRows.length, 1, label);
      assert.strictEqual(sqlRows[0].day, js.day, label + ' day');
      assert.strictEqual(sqlRows[0].hour, js.hour, label + ' hour');
    }
  }
});

// ---- ingest 写路径 ----

test('ingest：按本地小时分桶，心跳与 instance_online 不入桶', (t) => {
  const { db, dao } = openTempDb(t);
  const t10 = at(2026, 7, 3, 10, 30);
  const t15 = at(2026, 7, 3, 15, 5);
  ingestBatch(dao, [
    ev({ eventId: 's1', type: 'session_start', ts: t10.toISOString(), payload: {} }),
    ev({ eventId: 'r1', type: 'bp_run_end', ts: t15.toISOString(), payload: { status: 'done' } }),
    ev({ eventId: 'hb', type: 'instance_heartbeat', ts: t10.toISOString(), payload: {} }),
    ev({ eventId: 'on', type: 'instance_online', ts: t10.toISOString(), payload: {} }),
  ], at(2026, 7, 3, 20, 0));
  const rows = hoursOf(db, '');
  assert.deepStrictEqual(rows.map((r) => [r.hour, r.events, r.sessions, r.runs]),
    [[10, 1, 1, 0], [15, 1, 0, 1]], '只有两个实质事件入桶，心跳/online 不入');
});

test('ingest：不合格事件**丢弃并计数**（不像 recency 那样回落 server_ts）', (t) => {
  const { db, dao } = openTempDb(t);
  const now = at(2026, 7, 3, 20, 0);
  ingestBatch(dao, [
    ev({ eventId: 'skew', type: 'session_start', ts: new Date(now.getTime() + 3600e3).toISOString(), payload: {} }),
    ev({ eventId: 'nots', type: 'session_start', payload: {} }),                       // 无 ts
    ev({ eventId: 'bad', type: 'session_start', ts: 'not-a-date', payload: {} }),
    ev({ eventId: 'ok', type: 'session_start', ts: at(2026, 7, 3, 9, 0).toISOString(), payload: {} }),
  ], now);
  assert.strictEqual(hoursOf(db, '').length, 1, '只有合格的那条入桶');
  assert.strictEqual(hoursOf(db, '')[0].hour, 9);
  assert.strictEqual(dao.qHourDropped(), 3, '三条不合格必须被计数（否则是静默漏数据）');
  // recency 对同一批事件是**回落**而非丢弃——两者刻意不同，此处守住这个差异
  assert.ok(db.prepare('SELECT last_at FROM daily_user').get().last_at, 'last_at 仍有值（回落 server_ts）');
});

test('ingest：丢弃计数存成整数串，不带小数点（meta 是 TEXT 列，算术结果要 CAST）', (t) => {
  const { db, dao } = openTempDb(t);
  const now = at(2026, 7, 3, 20, 0);
  for (let i = 0; i < 3; i++) {
    ingestBatch(dao, [ev({ eventId: 'n' + i, type: 'session_start', payload: {} })], now);
  }
  const raw = db.prepare("SELECT value FROM meta WHERE key = 'hour_dropped_clock_skew'").get().value;
  assert.strictEqual(raw, '3', '累加多次后仍是干净的整数串，实际值：' + raw);
});

test('全局行 ≠ 各工作流行之和（会话类事件没有 blueprintId，只进全局行）', (t) => {
  const { db, dao } = openTempDb(t);
  const when = at(2026, 7, 3, 11, 0);
  ingestBatch(dao, [
    ev({ eventId: 's1', type: 'session_start', ts: when.toISOString(), payload: {} }),
    ev({ eventId: 'r1', type: 'bp_run_end', ts: when.toISOString(), payload: { status: 'done', blueprintId: 'bp-a' } }),
  ], at(2026, 7, 3, 20, 0));
  const g = hoursOf(db, '');
  const b = hoursOf(db, 'bp-a');
  assert.strictEqual(g[0].events, 2, '全局含会话 + run');
  assert.strictEqual(b[0].events, 1, '工作流只含带 blueprintId 的那条');
  assert.notStrictEqual(g[0].events, b[0].events, '这个不等是设计使然，不是 bug');
});

// ---- 夜间重算 ----

test('夜间重算：窗口内重建且幂等，窗口外的补发行不被误清', (t) => {
  const { db, dao } = openTempDb(t);
  const now = at(2026, 7, 3, 20, 0);
  const today = localDay(now);
  // ① 今天的正常事件 ② 一条 spool 补发件：今天收到，但发生在 10 天前
  ingestBatch(dao, [
    ev({ eventId: 'a', type: 'session_start', ts: at(2026, 7, 3, 9, 0).toISOString(), payload: {} }),
    ev({ eventId: 'old', type: 'session_start', ts: at(2026, 6, 24, 14, 0).toISOString(), payload: {} }),
  ], now);
  const before = hoursOf(db, '');
  assert.strictEqual(before.length, 2, '补发件按它真实发生的那天入桶');

  const from = shiftDay(today, -3);
  dao.recomputeDailyHour(from);
  const after = hoursOf(db, '');
  assert.deepStrictEqual(after, before, '重算不得改变结果（窗口外那行也必须原样保留）');

  // 人为写脏窗口内的行，重算应修回；窗口外的行不受影响
  db.prepare("UPDATE daily_hour SET events = 999 WHERE day = ?").run(today);
  dao.recomputeDailyHour(from);
  assert.deepStrictEqual(hoursOf(db, ''), before, '窗口内被写脏的行应被修回');

  runNightlyJob(dao, { nowFn: () => now }); // 走完整 job 一遍，确认已挂进去
  assert.deepStrictEqual(hoursOf(db, ''), before);
});

test('daily_hour 永久保留：90 天清理只删 events，不碰时段表', (t) => {
  const { db, dao } = openTempDb(t);
  const now = at(2026, 7, 3, 20, 0);
  const oldDay = shiftDay(localDay(now), -200);
  db.prepare("INSERT INTO daily_hour (day, hour, blueprint_id, events, sessions, runs) VALUES (?, 9, '', 5, 5, 0)").run(oldDay);
  runNightlyJob(dao, { nowFn: () => now, retentionDays: 90 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM daily_hour WHERE day = ?').get(oldDay).c, 1,
    '200 天前的时段行必须还在（daily_hour 不进滚动清理）');
});

// ---- 端点 ----

test('/stats/hours：折成周几×小时，窗口固定且不受 from/to 影响', async (t) => {
  const NOW = at(2026, 7, 3, 20, 0); // 2026-08-03 是周一
  const h = await makeApp(t, { nowFn: () => NOW });
  // 连续 3 个**过去**的周一（7/20、7/27、8/3）10 点各一条 → 应汇聚到同一个格子。
  // 用未来日期会同时踩两个坑：既不在 [today-29, today] 窗口内，语义上也不该存在。
  for (const [mo, d] of [[6, 20], [6, 27], [7, 3]]) {
    const when = at(2026, mo, d, 10, 0);
    ingestBatch(h.dao, [ev({ eventId: `m${mo}-${d}`, type: 'bp_run_end', ts: when.toISOString(),
      payload: { status: 'done', blueprintId: 'bp-a' } })], when);
  }
  const { json } = await getJson(h.baseUrl, '/v1/stats/hours');
  const d = json.data;
  assert.strictEqual(d.days, 30);
  assert.strictEqual(d.blueprintId, '');
  const cell = d.cells.find((c) => c.hour === 10);
  assert.strictEqual(cell.weekday, 1, '周一 = 1');
  assert.strictEqual(cell.events, 3, '三个周一汇聚到同一格');
  assert.strictEqual(d.cells.length, 1, '只返回非空格子，补零交前端');

  // days 参数可调，但顶栏 from/to 在这里**没有意义**（不接受、也不该影响结果）
  const narrow = (await getJson(h.baseUrl, '/v1/stats/hours?days=7')).json.data;
  assert.strictEqual(narrow.days, 7);
  assert.strictEqual(narrow.cells[0].events, 1, '近 7 天只剩今天那一个周一');
});

test('/stats/hours：blueprintId 过滤 + 丢弃计数外露 + 超长 id 400', async (t) => {
  const NOW = at(2026, 7, 3, 20, 0);
  const h = await makeApp(t, { nowFn: () => NOW });
  const when = at(2026, 7, 3, 11, 0);
  ingestBatch(h.dao, [
    ev({ eventId: 's1', type: 'session_start', ts: when.toISOString(), payload: {} }),
    ev({ eventId: 'r1', type: 'bp_run_end', ts: when.toISOString(), payload: { status: 'done', blueprintId: 'bp-a' } }),
    ev({ eventId: 'bad', type: 'session_start', payload: {} }), // 无 ts → 丢弃并计数
  ], NOW);

  const g = (await getJson(h.baseUrl, '/v1/stats/hours')).json.data;
  const b = (await getJson(h.baseUrl, '/v1/stats/hours?blueprintId=bp-a')).json.data;
  assert.strictEqual(g.cells[0].events, 2);
  assert.strictEqual(b.cells[0].events, 1);
  assert.strictEqual(g.droppedClockSkew, 1, '丢弃数必须外露，否则漏数据是静默的');
  assert.strictEqual(g.coveredDays, 1);

  const long = (await getJson(h.baseUrl, '/v1/stats/hours?blueprintId=' + 'x'.repeat(300))).status;
  assert.strictEqual(long, 400);
});

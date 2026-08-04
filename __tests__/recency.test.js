'use strict';
// recency.test.js —— P2「上次实质使用」口径：三条写路径（ingest / 夜间重算 / 回填）必须逐位一致。
//
// 三条路径分别用 JS（ingest.js::eventAtOf）与 SQL（db.js::EVENT_AT_EXPR）实现同一个规则，
// 一旦漂移，夜间重算就会静默改掉 ingest 写对的值——而且没人看得出来。故第一组用例逐例对拍。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { openTempDb } = require('./helpers');
const { openDb } = require('../lib/db');
const { ingestBatch, eventAtOf, RECENCY_TYPES } = require('../lib/ingest');
const { runNightlyJob } = require('../lib/aggregate');

const A = { schemaVersion: 1, installId: 'i1', user: 'u1', host: 'h1', appVersion: '1.0.0' };
const ev = (over) => Object.assign({}, A, over);

const lastUser = (db) => db.prepare('SELECT last_at FROM daily_user').get().last_at;
const lastBp = (db) => db.prepare('SELECT last_at FROM daily_blueprint').get().last_at;

// ---- 口径对拍：JS 与 SQL ----

test('eventAt：JS 与 SQL 对同一批输入逐例一致（含带偏移的老格式）', (t) => {
  const { db } = openTempDb(t);
  // 借 events 表跑 SQL 侧表达式——与夜间重算/回填走的是同一段 SQL
  const cases = [
    ['2026-08-03T01:30:00.000Z', '2026-08-03T01:30:02.500Z', '正常 UTC'],
    ['2026-08-03T09:30:00+08:00', '2026-08-03T01:30:02.500Z', '带偏移（旧文档示例格式）'],
    [null, '2026-08-03T01:30:02.500Z', 'ts 缺失（选填字段）'],
    ['not-a-date', '2026-08-03T01:30:02.500Z', '不可解析'],
    ['2026-08-03T02:00:00.000Z', '2026-08-03T01:30:02.500Z', '未来 30min → 时钟走快，回落'],
    ['2026-08-03T01:33:00.000Z', '2026-08-03T01:30:02.500Z', '未来 3min → 容差内，采信'],
    ['2026-07-30T22:15:00.000Z', '2026-08-03T01:30:02.500Z', '早 4 天 → spool 补发，采信'],
  ];
  cases.forEach(([clientTs, serverTs], i) => {
    db.prepare(`INSERT INTO events (event_id, install_id, user, host, type, client_ts, server_ts, day, payload)
      VALUES (?, 'i1', 'u', 'h', 'session_start', ?, ?, '2026-08-03', '{}')`).run('e' + i, clientTs, serverTs);
  });
  // 逐行取 SQL 侧结果（recompute 用的就是这段表达式；这里借 recompute 落到 daily_user 上验证）
  const rows = db.prepare('SELECT event_id, client_ts, server_ts FROM events ORDER BY event_id').all();
  for (const r of rows) {
    const jsVal = eventAtOf({ ts: r.client_ts }, r.server_ts, Date.parse(r.server_ts));
    // 单行重算：清表→只留这一行→recompute→读 last_at
    const one = openTempDb(t);
    one.db.prepare(`INSERT INTO events (event_id, install_id, user, host, type, client_ts, server_ts, day, payload)
      VALUES ('x', 'i1', 'u', 'h', 'session_start', ?, ?, '2026-08-03', '{}')`).run(r.client_ts, r.server_ts);
    one.dao.recomputeDaily('2026-08-01');
    assert.strictEqual(lastUser(one.db), jsVal,
      `client_ts=${r.client_ts} server_ts=${r.server_ts}：SQL 与 JS 不一致`);
  }
});

// ---- ingest 写路径 ----

test('ingest：心跳与 instance_online 不推进 last_at（避免"挂机=活跃"）', (t) => {
  const { db, dao } = openTempDb(t);
  const now = new Date('2026-08-03T04:00:00.000Z');
  ingestBatch(dao, [
    ev({ eventId: 'hb', type: 'instance_heartbeat', ts: '2026-08-03T03:00:00.000Z', payload: {} }),
    ev({ eventId: 'on', type: 'instance_online', ts: '2026-08-03T03:01:00.000Z', payload: {} }),
  ], now);
  assert.strictEqual(lastUser(db), null, '只有心跳/online 时 last_at 必须为 null');
  // RECENCY_TYPES 名单本身也守一道（与 db.js 的 RECENCY_TYPES_SQL 同步改）
  assert.ok(!RECENCY_TYPES.has('instance_heartbeat'));
  assert.ok(!RECENCY_TYPES.has('instance_online'));
  assert.ok(!RECENCY_TYPES.has('update_apply'), 'update_apply 是安装面事件，不算使用');
});

test('ingest：spool 补发用 client_ts（不因重连而虚报新鲜度）', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [ev({ eventId: 's1', type: 'session_start', ts: '2026-08-01T10:00:00.000Z', payload: {} })],
    new Date('2026-08-03T04:00:00.000Z'));
  assert.strictEqual(lastUser(db), '2026-08-01T10:00:00.000Z');
});

test('ingest：时钟走快超容差 → 回落 server_ts', (t) => {
  const { db, dao } = openTempDb(t);
  ingestBatch(dao, [ev({ eventId: 's1', type: 'session_start', ts: '2026-08-03T09:00:00.000Z', payload: {} })],
    new Date('2026-08-03T04:00:00.000Z'));
  assert.strictEqual(lastUser(db), '2026-08-03T04:00:00.000Z');
});

test('ingest：last_at 取 MAX，后到的更早事件不会把它拉低', (t) => {
  const { db, dao } = openTempDb(t);
  const now = new Date('2026-08-03T04:00:00.000Z');
  ingestBatch(dao, [ev({ eventId: 'a', type: 'session_start', ts: '2026-08-03T03:50:00.000Z', payload: {} })], now);
  ingestBatch(dao, [ev({ eventId: 'b', type: 'session_start', ts: '2026-08-03T01:00:00.000Z', payload: {} })], now);
  assert.strictEqual(lastUser(db), '2026-08-03T03:50:00.000Z');
});

test('ingest：工作流 last_at 只由带 blueprintId 的 run/失败推进', (t) => {
  const { db, dao } = openTempDb(t);
  const now = new Date('2026-08-03T04:00:00.000Z');
  ingestBatch(dao, [
    ev({ eventId: 'r1', type: 'bp_run_end', ts: '2026-08-03T03:30:00.000Z',
      payload: { status: 'done', blueprintId: 'bp-a' } }),
    // 无 blueprintId 的失败不归因任何工作流
    ev({ eventId: 'f1', type: 'failure_event', ts: '2026-08-03T03:59:00.000Z', payload: { kind: 'x' } }),
  ], now);
  assert.strictEqual(lastBp(db), '2026-08-03T03:30:00.000Z');
  assert.strictEqual(lastUser(db), '2026-08-03T03:59:00.000Z', '用户维度仍认这条失败');
});

// ---- 夜间重算 ----

test('夜间重算：last_at 被重算且与 ingest 结果一致（不是唯一不自愈的字段）', (t) => {
  const { db, dao } = openTempDb(t);
  const now = new Date(2026, 7, 3, 12, 0, 0); // 本地时间，保证 localDay 落在今天
  const day = require('../lib/time-utils').localDay(now);
  ingestBatch(dao, [
    ev({ eventId: 's1', type: 'session_start', ts: '2026-08-03T03:00:00.000Z', payload: {} }),
    ev({ eventId: 'r1', type: 'bp_run_end', ts: '2026-08-03T04:30:00.000Z',
      payload: { status: 'done', blueprintId: 'bp-a' } }),
  ], now);
  const beforeUser = lastUser(db), beforeBp = lastBp(db);
  assert.strictEqual(beforeUser, '2026-08-03T04:30:00.000Z');
  // 人为写脏，再让夜间 job 修回来
  db.prepare('UPDATE daily_user SET last_at = ?').run('1999-01-01T00:00:00.000Z');
  db.prepare('UPDATE daily_blueprint SET last_at = NULL').run();
  runNightlyJob(dao, { nowFn: () => now });
  assert.strictEqual(lastUser(db), beforeUser, '重算应把写脏的 last_at 修回');
  assert.strictEqual(lastBp(db), beforeBp);
  assert.ok(day);
});

// ---- 回填 ----

test('回填：精确回填 + 日精度兜底 + 心跳日保持 NULL + 幂等', (t) => {
  const { db, dao } = openTempDb(t);
  // 近 3 天有 events（可精确回填）
  for (const d of ['2026-07-30', '2026-07-31', '2026-08-01']) {
    ingestBatch(dao, [
      ev({ eventId: 's' + d, type: 'session_start', ts: d + 'T03:00:00.000Z', payload: {} }),
      ev({ eventId: 'r' + d, type: 'bp_run_end', ts: d + 'T04:30:00.000Z',
        payload: { status: 'done', blueprintId: 'bp-a' } }),
      ev({ eventId: 'h' + d, type: 'instance_heartbeat', ts: d + 'T04:45:00.000Z', payload: {} }),
    ], new Date(d + 'T05:00:00.000Z'));
  }
  // 模拟存量：清空 last_at，并补两行「events 已被 90 天清理」的老数据
  db.exec('UPDATE daily_user SET last_at = NULL; UPDATE daily_blueprint SET last_at = NULL');
  db.prepare(`INSERT INTO daily_user (day, install_id, user, host, heartbeats, sessions, session_ms,
      runs_done, runs_failed, runs_halted, failures, run_active_ms, in_tokens, out_tokens, last_at)
    VALUES ('2026-05-01', 'iOld', 'uOld', 'hOld', 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, NULL)`).run();
  db.prepare(`INSERT INTO daily_user (day, install_id, user, host, heartbeats, sessions, session_ms,
      runs_done, runs_failed, runs_halted, failures, run_active_ms, in_tokens, out_tokens, last_at)
    VALUES ('2026-05-02', 'iHb', 'uHb', 'hHb', 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL)`).run();

  const runBackfill = () => {
    for (const d of dao.qDaysWithEvents('')) dao.backfillDay(d);
    dao.backfillFallbackBefore('2026-07-30');
  };
  runBackfill();

  const snap = () => db.prepare('SELECT day, install_id k, last_at FROM daily_user ORDER BY day, install_id').all()
    .concat(db.prepare('SELECT day, blueprint_id k, last_at FROM daily_blueprint ORDER BY day, blueprint_id').all());
  const first = snap();

  const byKey = Object.fromEntries(first.map((r) => [r.day + '/' + r.k, r.last_at]));
  // 精确：取当日实质事件的 MAX（04:30 的 run），心跳 04:45 **不**参与
  assert.strictEqual(byKey['2026-07-31/i1'], '2026-07-31T04:30:00.000Z');
  // 兜底：events 已清理的老行 → 日精度 12:00Z（在 [-12,+12] 任何部署时区下都仍属同一本地日）
  assert.strictEqual(byKey['2026-05-01/iOld'], '2026-05-01T12:00:00.000Z');
  // 纯心跳日：没有实质使用，last_at 应保持 NULL（语义 = 装了但当天没用），兜底不得误填
  assert.strictEqual(byKey['2026-05-02/iHb'], null);

  runBackfill();
  runBackfill();
  assert.deepStrictEqual(snap(), first, '回填必须幂等：重复执行结果逐位相同');
});

// ---- 端点：沉默实体如何进结果集 ----

// 三个工作流：live 今天还在跑；quiet 40 天前跑过 5 次（过准入线）；toy 60 天前只跑 1 次（被挡）
const NOW_EP = new Date(2026, 7, 3, 12, 0, 0);
function seedSilent(dao) {
  const at = (daysAgo) => new Date(NOW_EP.getTime() - daysAgo * 864e5);
  const mk = (id, type, when, payload) => ev({ eventId: id, type, ts: when.toISOString(), payload });
  const run = (id, bp, when) => mk(id, 'bp_run_end', when, { status: 'done', blueprintId: bp });
  for (let i = 0; i < 4; i++) ingestBatch(dao, [run('l' + i, 'bp-live', at(0))], at(0));
  for (let i = 0; i < 5; i++) ingestBatch(dao, [run('q' + i, 'bp-quiet', at(40))], at(40));
  ingestBatch(dao, [run('t0', 'bp-toy', at(60))], at(60));
}

async function silentApp(t) {
  const { makeApp } = require('./helpers');
  const h = await makeApp(t, { nowFn: () => NOW_EP });
  seedSilent(h.dao);
  return h;
}

test('blueprints：沉默工作流被补进结果集（指标补 0），准入线挡掉一次性实验品', async (t) => {
  const { getJson } = require('./helpers');
  const { baseUrl } = await silentApp(t);
  const { json } = await getJson(baseUrl, '/v1/stats/blueprints'); // 缺省近 30 天
  const d = json.data;
  const by = Object.fromEntries(d.blueprints.map((b) => [b.blueprintId, b]));

  assert.strictEqual(by['bp-live'].runs, 4);
  assert.strictEqual(by['bp-live'].silentDays, 0, '今天跑过 → 沉默 0 天');

  // 40 天前的工作流在「近 30 天」区间聚合里一行都没有——不显式补出来就永远看不见它
  assert.ok(by['bp-quiet'], 'lifetimeRuns≥3 的沉默工作流必须出现');
  assert.strictEqual(by['bp-quiet'].runs, 0);
  assert.strictEqual(by['bp-quiet'].lifetimeRuns, 5);
  assert.strictEqual(by['bp-quiet'].silentDays, 40);

  assert.ok(!by['bp-toy'], '累计 <3 次的一次性实验品不进沉默名单');
  assert.strictEqual(d.hiddenSilent, 1, '被挡掉的个数要报出来，不能静默隐藏');
  assert.strictEqual(d.silentMinLifetimeRuns, 3);
});

test('blueprints：切到 90 天后 bp-quiet 回到活跃行（沉默是相对区间的）', async (t) => {
  const { getJson } = require('./helpers');
  const { baseUrl } = await silentApp(t);
  const { localDay: ld, shiftDay: sd } = require('../lib/time-utils');
  const to = ld(NOW_EP), from = sd(to, -89);
  const { json } = await getJson(baseUrl, `/v1/stats/blueprints?from=${from}&to=${to}`);
  const q = json.data.blueprints.find((b) => b.blueprintId === 'bp-quiet');
  assert.strictEqual(q.runs, 5, '90 天窗内它是活跃的');
  assert.strictEqual(q.silentDays, 40, '但 silentDays 是全局量，不随区间变');
});

test('users/top?metric=silentDays：按沉默降序，排出区间内零活动的人', async (t) => {
  const { makeApp, getJson } = require('./helpers');
  const h = await makeApp(t, { nowFn: () => NOW_EP });
  const at = (daysAgo) => new Date(NOW_EP.getTime() - daysAgo * 864e5);
  // gone 45 天前用过后消失；live 今天在用；hbOnly 只有心跳（lastAt 为 NULL = 从没实质用过）
  ingestBatch(h.dao, [ev({ eventId: 'g1', installId: 'iG', user: 'gone', host: 'H',
    type: 'session_start', ts: at(45).toISOString(), payload: {} })], at(45));
  ingestBatch(h.dao, [ev({ eventId: 'v1', installId: 'iV', user: 'live', host: 'H',
    type: 'session_start', ts: at(0).toISOString(), payload: {} })], at(0));
  ingestBatch(h.dao, [ev({ eventId: 'b1', installId: 'iB', user: 'hbOnly', host: 'H',
    type: 'instance_heartbeat', ts: at(2).toISOString(), payload: {} })], at(2));

  const { json } = await getJson(h.baseUrl, '/v1/stats/users/top?metric=silentDays&limit=10');
  const order = json.data.users.map((u) => u.user);
  assert.strictEqual(order[0], 'hbOnly', '从没实质使用过的排最前（最强信号，不是缺数据）');
  assert.strictEqual(json.data.users[0].silentDays, null);
  assert.strictEqual(order[1], 'gone');
  assert.strictEqual(json.data.users[1].silentDays, 45);
  assert.strictEqual(order[order.length - 1], 'live');
  assert.strictEqual(json.data.users[order.length - 1].silentDays, 0);
});

test('users/top：沉默榜默认 50 条、高频榜默认 10 条（流失名单要看全）', async (t) => {
  const { makeApp, getJson } = require('./helpers');
  const h = await makeApp(t, { nowFn: () => NOW_EP });
  const at = (daysAgo) => new Date(NOW_EP.getTime() - daysAgo * 864e5);
  for (let i = 0; i < 60; i++) {
    ingestBatch(h.dao, [ev({ eventId: 'u' + i, installId: 'i' + i, user: 'user' + i, host: 'H',
      type: 'session_start', ts: at(i + 1).toISOString(), payload: {} })], at(i + 1));
  }
  const silent = (await getJson(h.baseUrl, '/v1/stats/users/top?metric=silentDays')).json.data;
  assert.strictEqual(silent.users.length, 50, '沉默榜缺省 50');
  const top = (await getJson(h.baseUrl, '/v1/stats/users/top?metric=sessions')).json.data;
  assert.strictEqual(top.users.length, 10, '高频榜缺省仍是 10');
  // 显式 limit 仍然优先，且上限 100 不变
  const explicit = (await getJson(h.baseUrl, '/v1/stats/users/top?metric=silentDays&limit=5')).json.data;
  assert.strictEqual(explicit.users.length, 5);
  const capped = (await getJson(h.baseUrl, '/v1/stats/users/top?metric=silentDays&limit=999')).json.data;
  assert.ok(capped.users.length <= 100, '上限 100');
});

test('users/top：metric 白名单接受 silentDays，仍拒绝非法值', async (t) => {
  const { getJson } = require('./helpers');
  const { baseUrl } = await silentApp(t);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/users/top?metric=silentDays')).status, 200);
  assert.strictEqual((await getJson(baseUrl, '/v1/stats/users/top?metric=nope')).status, 400);
});

test('export：两个 CSV 加 recency 两列，且与看板同口径（含沉默实体）', async (t) => {
  const { makeApp } = require('./helpers');
  const h = await makeApp(t, { nowFn: () => NOW_EP });
  seedSilent(h.dao);
  const at = (daysAgo) => new Date(NOW_EP.getTime() - daysAgo * 864e5);
  ingestBatch(h.dao, [ev({ eventId: 'g1', installId: 'iG', user: 'gone', host: 'H',
    type: 'session_start', ts: at(45).toISOString(), payload: {} })], at(45));

  const bp = await (await fetch(h.baseUrl + '/v1/export/blueprints')).text();
  assert.match(bp.split('\n')[0], /,上次活跃,沉默天数\s*$/);
  assert.ok(bp.includes('bp-quiet,0,'), '沉默工作流要进导出（与看板同口径）');
  assert.ok(!bp.includes('bp-toy'), '被准入线挡掉的也不进导出');

  const us = await (await fetch(h.baseUrl + '/v1/export/users')).text();
  assert.match(us.split('\n')[0], /,上次活跃,沉默天数\s*$/);
  assert.ok(/\ngone,H,0,/.test(us), '区间内零活动的沉默用户要进导出');
});

test('回填脚本：库不存在时报错退出，不静默造空库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bf-'));
  const missing = path.join(dir, 'nope.db');
  let failed = false;
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'backfill.js'), '--db', missing],
      { stdio: 'pipe' });
  } catch (_) { failed = true; }
  assert.ok(failed, '应以非 0 退出');
  assert.ok(!fs.existsSync(missing), '不得创建空库');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

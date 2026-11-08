'use strict';
// 执行器体检（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §11.2 D2）：每行判据 + 两个挂点的牙齿。
// 牙齿 ①：体检红 ⇒ 不标 batched、attempts 不变、不调 /_blueprint/run（撤门 ⇒ 桩会记到 run 调用）。
// 牙齿 ②：起 run 回 503 ⇒ 样本原样 queued、attempts 0、错误含工具名、余下蓝图不跑（换回 evoReleaseBatch ⇒ attempts=1）。

const test = require('node:test');
const assert = require('node:assert');

const { createHealth } = require('../lib/center/health');
const { PARTNER_OPS } = require('../lib/center/partner-ops');
const { makeApp } = require('./helpers');
const { BP, setup, proposal, ingest } = require('./_evolve-fixtures');

// ---- 假客户端（单元：每行判据）----
function fakeClient(o) {
  const c = Object.assign({
    settingsOk: true, standalone: true, version: '1.0.0', installRoot: '/opt/cancong',
    marketplaces: [{ name: 'mk', url: 'https://x.invalid/m.git', ref: 'main' }],
    ops: PARTNER_OPS, openapiOk: true, env: '0', catalogOk: true, calls: 0,
  }, o || {});
  const R = (ok, body, status) => Promise.resolve({ ok, status: status || (ok ? 200 : 502), body });
  return Object.assign(c, {
    baseUrl: 'http://127.0.0.1:5599',
    settings: () => { c.calls++; return c.settingsOk ? R(true, { settings: { standalone: c.standalone, version: c.version, installRoot: c.installRoot, marketplaces: c.marketplaces } }) : R(false, { error: 'ECONNREFUSED' }, 0); },
    openapi: () => {
      if (!c.openapiOk) return R(false, { error: 'not found' }, 404);
      const paths = {};
      for (const [m, p] of c.ops) (paths[p] = paths[p] || {})[m] = { 'x-stability': 'partner' };
      return R(true, { info: { version: c.version }, paths });
    },
    envList: () => R(true, { ok: true, rows: c.env === undefined ? [] : [{ key: 'env.bp_evolve', currentValue: c.env }] }),
    catalog: () => (c.catalogOk ? R(true, { ok: true, blueprints: [] }) : R(false, { code: 'market-fetch-failed' }, 502)),
  });
}
const fakeDao = (market) => ({ metaGet: () => (market ? JSON.stringify({ market }) : null) });
const item = (h, id) => h.items.find((x) => x.id === id) || {};

test('全绿：canRun / canPush 皆真；没有 Linux 包 ⇒ 版本行 na', async () => {
  const h = await createHealth(fakeClient(), { ttlMs: 0 }).check();
  assert.deepStrictEqual([h.overall, h.canRun, h.canPush], ['ok', true, true]);
  assert.deepStrictEqual(h.items.map((x) => [x.id, x.level]),
    [['reachable', 'ok'], ['standalone', 'ok'], ['contract', 'ok'], ['evolveOff', 'ok'], ['market', 'ok'], ['version', 'na']]);
});

test('连不上 ⇒ 红、canRun=false、其余项不再查', async () => {
  const h = await createHealth(fakeClient({ settingsOk: false })).check();
  assert.deepStrictEqual([h.canRun, h.canPush, item(h, 'reachable').level, h.items.length], [false, false, 'red', 1]);
  assert.match(item(h, 'reachable').hint, /OPS_CANCONG_URL/);
});

test('不是独立版 ⇒ 红', async () => {
  const h = await createHealth(fakeClient({ standalone: false })).check();
  assert.deepStrictEqual([item(h, 'standalone').level, h.canRun], ['red', false]);
});

test('契约：在线规格缺某 partner op（或取不到规格）⇒ 红并点名', async () => {
  const h = await createHealth(fakeClient({ ops: PARTNER_OPS.filter(([, p]) => p !== '/_env/list'), version: '0.9.0' })).check();
  assert.deepStrictEqual([item(h, 'contract').level, h.canRun], ['red', false]);
  assert.match(item(h, 'contract').msg, /0\.9\.0.*GET \/_env\/list/);
  const h2 = await createHealth(fakeClient({ openapiOk: false })).check();
  assert.strictEqual(item(h2, 'contract').level, 'red');
});

test('BP_EVOLVE 没关 ⇒ 黄、照跑', async () => {
  for (const env of [undefined, null, '1']) {
    const h = await createHealth(fakeClient({ env })).check();
    assert.deepStrictEqual([item(h, 'evolveOff').level, h.canRun, h.overall], ['warn', true, 'warn'], String(env));
  }
});

test('目标市场：读不出 ⇒ 红且 canPush=false（canRun 不受影响）；配置了但未登记 ⇒ 黄', async () => {
  const h = await createHealth(fakeClient({ catalogOk: false })).check();
  assert.deepStrictEqual([item(h, 'market').level, h.canRun, h.canPush], ['red', true, false]);
  const h2 = await createHealth(fakeClient({ marketplaces: [] })).check();
  assert.deepStrictEqual([item(h2, 'market').level, h2.canPush], ['red', false]);
  const h3 = await createHealth(fakeClient(), { dao: fakeDao({ name: 'other', url: 'https://y.invalid/m.git' }) }).check();
  assert.deepStrictEqual([item(h3, 'market').level, h3.canPush], ['warn', true]);
});

test('版本：feed 上同架构 Linux 包更新 ⇒ 黄 + 升级命令（带 sha 校验与安装根，不代执行）', async () => {
  const man = { version: '1.2.0', packages: { 'linux-x64': { file: 'cancong-server-1.2.0-linux-x64.tar.gz', sha256: 'ab'.repeat(32) } } };
  const h = await createHealth(fakeClient({ version: '1.1.9' }), { arch: 'x64', feedLatest: () => man, feedBase: 'http://127.0.0.1:5900' }).check();
  const v = item(h, 'version');
  assert.strictEqual(v.level, 'warn');
  assert.match(v.cmd, /^curl -fLo \/tmp\/cancong-server-1\.2\.0-linux-x64\.tar\.gz http:\/\/127\.0\.0\.1:5900\/v1\/update\/download\/cancong-server-1\.2\.0-linux-x64\.tar\.gz/);
  assert.match(v.cmd, /sha256sum -c - && sudo \/opt\/cancong\/bootstrap\.sh --upgrade \//);
  assert.strictEqual(h.canRun, true);
  const same = await createHealth(fakeClient({ version: '1.2.0' }), { arch: 'x64', feedLatest: () => man }).check();
  assert.strictEqual(item(same, 'version').level, 'ok');
  const otherArch = await createHealth(fakeClient({ version: '1.1.9' }), { arch: 'arm64', feedLatest: () => man }).check();
  assert.strictEqual(item(otherArch, 'version').level, 'na', '只比同架构的包');
});

test('TTL 内复用、并发去重、force 重查；缺工具标记进结果且不影响 canRun', async () => {
  let t0 = 1000;
  const c = fakeClient();
  const hl = createHealth(c, { ttlMs: 30000, nowFn: () => new Date(t0) });
  await Promise.all([hl.check(), hl.check()]);
  assert.strictEqual(c.calls, 1, '并发两次只查一次');
  t0 += 1000; await hl.check();
  assert.strictEqual(c.calls, 1, 'TTL 内用缓存');
  await hl.check({ force: true });
  assert.strictEqual(c.calls, 2);
  hl.noteToolMissing('opencode');
  const h = await hl.check();
  assert.deepStrictEqual([item(h, 'tool').level, h.canRun], ['red', true]);
  assert.match(item(h, 'tool').msg, /opencode/);
  hl.clearToolMissing();
  assert.strictEqual(item(await hl.check(), 'tool').level, undefined);
});

// ---- 挂点（真 runner + 桩蚕丛）----
const sampleRows = (ctx) => ctx.db.prepare('SELECT bp_id AS bp, status, attempts, batch_id AS batch FROM evolve_samples ORDER BY id').all();

test('★ 牙齿①：体检红 ⇒ 队列不开跑：不标 batched、attempts 不变、不调 /_blueprint/run，记一条失败批次', async (t) => {
  const ctx = await setup(t, { standalone: false });
  await ingest(ctx.baseUrl, [proposal('sigA')]);
  const r = await ctx.runner.processQueue({ trigger: 'manual' });
  assert.deepStrictEqual([r.ok, r.blocked], [false, true]);
  assert.ok(!ctx.stub.calls.includes('POST /_blueprint/run'), '体检红不该起 run');
  assert.deepStrictEqual(sampleRows(ctx), [{ bp: BP, status: 'queued', attempts: 0, batch: null }]);
  const b = ctx.dao.evoBatchList(10, 0).rows[0];
  assert.strictEqual(b.status, 'failed');
  assert.match(b.error, /^体检未过：不是独立版节点/);
});

test('★ 牙齿②：起 run 503 ⇒ 样本原样退回（attempts 0）、批次写明缺工具、余下蓝图不跑、体检亮缺工具', async (t) => {
  const ctx = await setup(t, { runFail: { status: 503, body: { error: 'tool binary unavailable', tool: 'opencode' } } });
  await ingest(ctx.baseUrl, [proposal('sigA'), proposal('sigB', { payload: { signature: 'sigB', blueprintId: 'bp-y', nodeId: 'n', signal: 'gate-fail', diff: 'd', rationale: 'r', evidence: [], runId: 'r-b' } })]);
  await ctx.runner.processQueue({ trigger: 'manual' });
  assert.strictEqual(ctx.stub.calls.filter((x) => x === 'POST /_blueprint/run').length, 1, '第二个蓝图不该再起 run');
  for (const row of sampleRows(ctx)) assert.deepStrictEqual([row.status, row.attempts, row.batch], ['queued', 0, null], JSON.stringify(row));
  const b = ctx.dao.evoBatchList(10, 0).rows[0];
  assert.match(b.error, /执行器缺工具 opencode（退回队列，不计重试）/);
  const h = (await fetch(ctx.baseUrl + '/v1/evolve/health').then((x) => x.json())).data;
  assert.match((h.items.find((x) => x.id === 'tool') || {}).msg || '', /opencode/);
  // 第二轮还是 503：仍不烧重试（两次失败也不会把样本标 failed）
  await ctx.runner.processQueue({ trigger: 'manual' });
  for (const row of sampleRows(ctx)) assert.strictEqual(row.attempts, 0);
});

test('路由：GET /v1/evolve/health 读缓存结果；刷新与立即处理 / 推送 / 导出的红灯拦截', async (t) => {
  const stub = await require('./_evolve-fixtures').stubCancong(t, { market: null });
  const ctx = await makeApp(t, { auth: true, cancongUrl: stub.url });
  const call = async (method, p, headers) => {
    const res = await fetch(ctx.baseUrl + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const tok = (await (await fetch(ctx.baseUrl + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json()).data.token;
  const H = { authorization: 'Bearer ' + tok };
  assert.strictEqual((await call('GET', '/v1/evolve/health')).status, 401, '门禁内');
  const h = (await call('GET', '/v1/evolve/health', H)).json.data;
  assert.deepStrictEqual([h.canRun, h.canPush], [true, false], '没登记市场 ⇒ 只拦推送');
  assert.strictEqual((await call('POST', '/v1/evolve/health/refresh', H)).status, 200);
  const push = await call('POST', '/v1/evolve/push/' + BP, H);
  assert.deepStrictEqual([push.status, push.json.code], [409, 'executor_unhealthy']);
  assert.ok(Array.isArray(push.json.items));
  assert.strictEqual((await call('GET', '/v1/evolve/export/' + BP, H)).status, 409);
  stub.standalone = false;
  await call('POST', '/v1/evolve/health/refresh', H);
  const run = await call('POST', '/v1/evolve/queue/run', H);
  assert.deepStrictEqual([run.status, run.json.code], [409, 'executor_unhealthy']);
});

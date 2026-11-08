'use strict';
// 跨仓契约：本仓桩蚕丛的响应、本仓发出的请求，都必须落在蚕丛 API 规格（TechDemos api-spec/dist/openapi.json）里
// （TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §11.1 D1）。
// 起因：批 4 桩把 GET /api/settings 写成扁平 {marketplaces}（真形状 {settings:{marketplaces}}），单测全绿、只有两仓 ST 抓到。
// 规格是唯一真源：蚕丛那边这 13 个 op 标 x-stability: partner、改形状有门禁；这边桩照规格写，偏了单测即红。
// 找不到 TechDemos ⇒ skip 并明说「未真对拍」（只有迷你校验器自测恒跑）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { validate, checkResponse, checkRequest } = require('./_openapi-mini');
const { techdemosDir } = require('./_techdemos-dir');
const { PARTNER_OPS } = require('../lib/center/partner-ops');
const { createCancongClient } = require('../lib/center/cancong-client');
const { BP, setup, adoptedPair, basketOf } = require('./_evolve-fixtures');

test('迷你校验器：拒收批 4 那份扁平 {marketplaces}，收真形状', () => {
  const doc = { paths: {} };
  const settings = { type: 'object', properties: { settings: { type: 'object', properties: {
    marketplaces: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, ref: { type: 'string' } } } },
  } } } };
  assert.ok(validate(doc, settings, { marketplaces: [] }, 'x', []).length > 0, '扁平形状必须报错');
  assert.deepStrictEqual(validate(doc, settings, { settings: { marketplaces: [{ name: 'a', url: 'u', ref: 'main' }] } }, 'x', []), []);
  assert.ok(validate(doc, settings, { settings: { marketplaces: [{ name: 'a', ref: 1 }] } }, 'x', []).length > 0, 'ref 类型错必须报错');
});

const loc = techdemosDir();
const specDoc = () => JSON.parse(fs.readFileSync(path.join(loc.dir, 'api-spec', 'dist', 'openapi.json'), 'utf8'));
const k = (m, p) => m + ' ' + p;

test('★ 桩响应 / 本仓请求 ⊆ 蚕丛规格；PARTNER_OPS ≡ 规格 partner 集合 ≡ 实际调用集合', async (t) => {
  if (!loc.dir) { t.skip('未真对拍：兄弟仓 TechDemos 不在（试过 ' + loc.tried.join('、') + '；设 TECHDEMOS_DIR 指过去）'); return; }
  const doc = specDoc();
  const records = [];

  // ① 真实流程：队列建两簇 → 采纳 → 推送（含 409 version-not-bumped 重试）
  const a = await setup(t, { publishPlan: [{ status: 409, body: { ok: false, code: 'version-not-bumped', error: '版本未高于市场', marketVersion: '1.2.5' } }] });
  await adoptedPair(a);
  const pushed = await basketOf(a).push(BP, 'admin');
  assert.strictEqual(pushed.ok, true, JSON.stringify(pushed));
  records.push(...a.stub.records);

  // ② 流程里走不到的调用：直接用真客户端打，请求形状仍出自生产代码
  const b = await setup(t);
  const c = createCancongClient({ baseUrl: b.stub.url });
  await c.putSettings({ marketplaces: [{ name: 'mk', url: 'https://example.invalid/m.git', ref: 'main' }] });
  await c.deleteBlueprint('no-such-bp');           // 404 分支
  await c.readFile('no-such-bp', 'blueprint.json'); // 404 分支
  await c.stopRun('/tmp/x', 'run1-0000-0000');
  await c.runState('/tmp/x');                        // 无 run ⇒ 404
  await c.openapi();
  await c.envList();
  records.push(...b.stub.records);

  const errs = [];
  for (const r of records) {
    if (!r.template) { errs.push('桩没走到路由：' + r.method + ' ' + r.path); continue; }
    errs.push(...checkResponse(doc, r), ...checkRequest(doc, r));
  }
  assert.deepStrictEqual(errs, [], '桩 / 请求与蚕丛规格不符——照规格改桩；若是蚕丛真改了形状，先在那边过 partner 门禁');

  const mine = PARTNER_OPS.map(([m, p]) => k(m, p)).sort();
  const inSpec = [];
  for (const [p, item] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(item)) if (op && op['x-stability'] === 'partner') inSpec.push(k(m, p));
  const exercised = [...new Set(records.map((r) => k(r.method, r.template)))].sort();
  assert.deepStrictEqual(inSpec.sort(), mine, 'PARTNER_OPS 与蚕丛规格里标 partner 的 op 不一致');
  assert.deepStrictEqual(exercised, mine, '用例实际打到的 op 与 PARTNER_OPS 不一致（新调用要登记，登记了的要有用例打到）');
});

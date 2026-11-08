'use strict';
// _evolve-fixtures.js —— 自进化中心用例共用夹具（_ 前缀：不进 *.test.js glob）。
// evolve-center.test.js 与 cancong-contract.test.js 共用同一个桩蚕丛：契约测试校验的就是单测在用的那份桩，
// 桩形状一旦偏离蚕丛规格（批 4 写成扁平 {marketplaces} 那次），单测阶段即红（TechDemos 设计 §11.1 D1）。
//
// 桩蚕丛：express 起在随机端口，记录每次回环调用（s.calls = "METHOD path"；s.records = 带模板 / 请求 / 响应的完整记录）；
// /_blueprint/run 收到即按 simulate 写出中心工作流的输出文件，再由 /_blueprint/state 报终态。

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { makeApp, makeEvent, postJson } = require('./helpers');
const { formatSynth } = require('../lib/center/patch');
const { createBasket } = require('../lib/center/basket');
const { createCancongClient } = require('../lib/center/cancong-client');
const { PARTNER_OPS } = require('../lib/center/partner-ops');

const BP = 'bp-x';
const BASE = '# n\n\n## 步骤\n1. 读需求\n2. 写代码\n3. 提交\n';

// ---------------- 桩蚕丛 ----------------
function stubCancong(t, o) {
  const s = Object.assign({
    calls: [], records: [], runs: [], publishes: [], writes: [],
    standalone: true, version: '1.0.0', installRoot: '/opt/cancong',
    env: { 'env.bp_evolve': '0' },     // /_env/list 的生效值（体检核 BP_EVOLVE 已关）
    partnerOps: PARTNER_OPS,          // /_api/openapi.json 里标 partner 的 op
    market: { name: 'mk', url: 'https://example.invalid/m.git', ref: 'main' },
    catalog: [{ id: BP, version: '1.2.3' }],
    marketFiles: { 'skills/n/SKILL.md': BASE },
    local: {},                        // 本机已装蓝图：id → { files }
    outcome: 'done',
    simulate: null,
    publishPlan: [],                  // 依次弹出：{status, body}
    runFail: null,                    // 设了 ⇒ /_blueprint/run 一律按它回（{status, body}）
  }, o || {});
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => {
    s.calls.push(req.method + ' ' + req.path);
    const json = res.json.bind(res);
    res.json = (b) => {
      s.records.push({
        method: req.method.toLowerCase(), path: req.path,
        template: req.route ? String(req.route.path).replace(/:([A-Za-z0-9_]+)/g, '{$1}') : null,
        query: Object.assign({}, req.query),
        body: req.method === 'GET' || req.method === 'DELETE' ? undefined : req.body,
        status: res.statusCode, resBody: b,
      });
      return json(b);
    };
    next();
  });
  app.get('/api/settings', (req, res) => res.json({ settings: {   // 同真蚕丛：嵌在 settings 里
    marketplaces: s.market ? [s.market] : [], standalone: s.standalone, version: s.version,
    ...(s.standalone ? { installRoot: s.installRoot } : {}),
  } }));
  app.get('/_api/openapi.json', (req, res) => {
    const paths = {};
    for (const [m, p] of s.partnerOps) (paths[p] = paths[p] || {})[m] = { summary: m + ' ' + p, 'x-audience': 'public', 'x-stability': 'partner' };
    res.json({ openapi: '3.1.0', info: { title: 'stub', version: s.version }, paths });
  });
  app.get('/_env/list', (req, res) => res.json({ ok: true,
    rows: Object.entries(s.env).map(([key, v]) => ({ key, currentValue: v, source: v == null ? 'default' : 'override', hasOverride: v != null })),
    needsRestartKeys: [] }));
  app.put('/api/settings', (req, res) => res.json({ ok: true }));
  app.get('/_marketplace/catalog', (req, res) => res.json({ ok: true, blueprints: s.catalog }));
  app.delete('/_blueprint/:id', (req, res) => {
    if (!s.local[req.params.id]) return res.status(404).json({ error: 'not found' });
    delete s.local[req.params.id]; res.json({ ok: true });
  });
  app.post('/_blueprint/import', (req, res) => {
    const src = req.body.source || {};
    if (src.type === 'market') {
      const id = src.installAs;
      if (s.local[id]) return res.status(409).json({ ok: false, code: 'id-collision' });
      s.local[id] = { files: Object.assign({ 'blueprint.json': JSON.stringify({ id, version: s.catalog[0].version }) }, s.marketFiles), market: src };
      return res.json({ ok: true, id, sourceId: src.id });
    }
    const bj = JSON.parse(fs.readFileSync(path.join(src.absPath, 'blueprint.json'), 'utf8'));
    s.local[bj.id] = { files: { 'blueprint.json': JSON.stringify(bj) }, absPath: src.absPath };
    res.json({ ok: true, id: bj.id });
  });
  app.get('/_blueprint/:id/file', (req, res) => {
    const b = s.local[req.params.id];
    const c = b && b.files[req.query.path];
    if (c == null) return res.status(404).json({ error: 'file not found' });
    res.json({ ok: true, encoding: 'utf8', content: c });
  });
  app.post('/_blueprint/:id/file', (req, res) => {
    s.writes.push({ id: req.params.id, path: req.body.path, content: req.body.content });
    s.local[req.params.id].files[req.body.path] = req.body.content;
    res.json({ ok: true });
  });
  app.post('/_blueprint/run', (req, res) => {
    if (s.runFail) return res.status(s.runFail.status).json(s.runFail.body);   // 如 503 {error, tool}：执行器缺工具
    const runId = 'run' + (s.runs.length + 1) + '-0000-0000';
    s.runs.push({ cwd: req.body.cwd, runId, blueprintId: req.body.blueprintId });
    if (s.simulate) s.simulate(req.body.cwd);
    res.status(202).json({ ok: true, runId });
  });
  app.get('/_blueprint/state', (req, res) => {
    const r = [...s.runs].reverse().find((x) => x.cwd === req.query.cwd);
    if (!r) return res.status(404).json({ error: 'none' });
    res.json({ state: { runId: r.runId }, runOutcome: { kind: s.outcome, stop: s.outcome === 'done' ? null : { code: 'other' } } });
  });
  app.post('/_blueprint/stop-session', (req, res) => res.json({ ok: true }));
  app.post('/_marketplace/publish', (req, res) => {
    s.publishes.push(req.body);
    const p = s.publishPlan.shift();
    if (p) return res.status(p.status).json(p.body);
    res.json({ ok: true, id: req.body.id, asId: req.body.asId, version: req.body.version, branch: 'publish/' + req.body.asId + '-' + req.body.version });
  });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      s.url = 'http://127.0.0.1:' + server.address().port;
      resolve(s);
    });
  });
}

// 中心工作流的「替身」：读输入，按 plan 写 assign / synth / review
function simulator(plan) {
  return (cwd) => {
    const samples = fs.readFileSync(path.join(cwd, 'input', 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const out = plan(samples, JSON.parse(fs.readFileSync(path.join(cwd, 'input', 'clusters.json'), 'utf8')));
    fs.writeFileSync(path.join(cwd, 'output', 'assign.json'), JSON.stringify(out.assign));
    for (const [ref, text] of Object.entries(out.synth || {})) fs.writeFileSync(path.join(cwd, 'output', 'synth', ref + '.txt'), text);
    fs.writeFileSync(path.join(cwd, 'output', 'review.json'), JSON.stringify(out.review || []));
  };
}

const SYN_A = formatSynth('提交前先跑单测', [{ find: '3. 提交\n', replace: '3. 跑单测\n4. 提交\n' }]);
const SYN_B = formatSynth('读需求时先列验收点', [{ find: '1. 读需求\n', replace: '1. 读需求并列出验收点\n' }]);

const proposal = (sig, over) => makeEvent(Object.assign({
  type: 'bp_patch_proposal', installId: 'inst-1',
  payload: { signature: sig, blueprintId: BP, nodeId: 'n', signal: 'gate-fail', diff: '--- FIND\n3. 提交\n+++ REPLACE\n3. 跑单测', rationale: '门禁总失败', evidence: [{ kind: 'gate', text: 'npm test failed' }], runId: 'r-' + sig },
}, over));
const ingest = (baseUrl, events) => postJson(baseUrl, '/v1/events', { events });

const basketOf = (ctx) => createBasket(ctx.dao, createCancongClient({ baseUrl: ctx.stub.url }));

async function setup(t, stubOpts) {
  const stub = await stubCancong(t, stubOpts);
  const app = await makeApp(t, { cancongUrl: stub.url });
  return Object.assign({ stub }, app);
}

// 一个 open 簇（经真实队列处理建出来），返回簇 id
async function seedCluster(ctx, sig, synth) {
  ctx.stub.simulate = simulator((samples) => ({
    assign: { assignments: samples.map((x) => ({ sample: x.ref, newKey: 'n1' })), newClusters: [{ key: 'n1', nodeId: 'n', title: '簇 ' + sig }] },
    synth: { n1: synth }, review: [{ ref: 'n1', pass: true, flags: [], notes: 'ok' }],
  }));
  await ingest(ctx.baseUrl, [proposal(sig)]);
  const r = await ctx.runner.processQueue({ trigger: 'manual' });
  assert.ok(r.ok && r.results.every((x) => x.ok), JSON.stringify(r));
  return ctx.dao.evoClusterList({ bp: BP, limit: 200 }).rows.find((c) => c.title === '簇 ' + sig).id;
}

async function adoptedPair(ctx) {
  const a = await seedCluster(ctx, 'sigA', SYN_A);
  const b = await seedCluster(ctx, 'sigB', SYN_B);
  const ts = new Date().toISOString();
  ctx.dao.evoSetClusterStatus(a, 'adopted', null, ts);
  ctx.dao.evoSetClusterStatus(b, 'adopted', null, ts);
  return [a, b];
}

module.exports = { BP, BASE, SYN_A, SYN_B, stubCancong, simulator, proposal, ingest, basketOf, setup, seedCluster, adoptedPair };

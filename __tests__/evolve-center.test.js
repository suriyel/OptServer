'use strict';
// 蓝图自进化批 4 · 中心（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §5 / §8 批 4 行）。
// 桩蚕丛：express 起在随机端口，记录每次回环调用；/_blueprint/run 收到即按 simulate 写出中心工作流的输出文件，
// 再由 /_blueprint/state 报终态 —— runner 走的是与真机同一条「写输入 → 起 run → 轮询 → 读输出」的路。
// §8 牙齿：① 同签名二次入库只加计数、零 LLM ② 已裁决簇不再出补丁 ③ 推送多簇合一分支、版本 +1。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const express = require('express');

const { makeApp, makeEvent, postJson, getJson } = require('./helpers');
const { parseSynth, applyHunks, formatSynth, bumpVersion } = require('../lib/center/patch');
const { holdoutCompare } = require('../lib/evolve-center');
const { createBasket } = require('../lib/center/basket');
const { createCancongClient } = require('../lib/center/cancong-client');

const BP = 'bp-x';
const BASE = '# n\n\n## 步骤\n1. 读需求\n2. 写代码\n3. 提交\n';

// ---------------- 桩蚕丛 ----------------
function stubCancong(t, o) {
  const s = Object.assign({
    calls: [], runs: [], publishes: [], writes: [],
    market: { name: 'mk', url: 'https://example.invalid/m.git', ref: 'main' },
    catalog: [{ id: BP, version: '1.2.3' }],
    marketFiles: { 'skills/n/SKILL.md': BASE },
    local: {},                        // 本机已装蓝图：id → { files }
    outcome: 'done',
    simulate: null,
    publishPlan: [],                  // 依次弹出：{status, body}
  }, o || {});
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => { s.calls.push(req.method + ' ' + req.path); next(); });
  app.get('/api/settings', (req, res) => res.json({ settings: { marketplaces: [s.market] } }));   // 同真蚕丛：嵌在 settings 里
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

// ---------------- 补丁格式 ----------------
test('补丁哨兵：解析 / 套用 / 锚点不唯一即拒 / 保留 CRLF', () => {
  const p = parseSynth(SYN_A);
  assert.strictEqual(p.summary, '提交前先跑单测');
  assert.strictEqual(applyHunks(BASE, p.hunks).text, BASE.replace('3. 提交\n', '3. 跑单测\n4. 提交\n'));
  assert.strictEqual(applyHunks(BASE + '3. 提交\n', p.hunks).ok, false, 'FIND 出现两次 ⇒ 拒');
  assert.strictEqual(applyHunks(BASE.replace(/\n/g, '\r\n'), p.hunks).text.includes('\r\n4. 提交\r\n'), true);
  assert.strictEqual(parseSynth('<<<FIND>>>\nx\n<<<END>>>\n'), null, 'FIND 没有 REPLACE ⇒ 格式坏');
  assert.strictEqual(parseSynth('<<<SUMMARY>>>\nx\n'), null, '没有 END ⇒ 格式坏');
  assert.strictEqual(bumpVersion('1.2.3'), '1.2.4');
});

// ---------------- 队列 + 牙齿 ① ----------------
test('队列：新签名进批 → 中心 run → 新簇 + 合成补丁入库；中心工作流按版本装进蚕丛', async (t) => {
  const ctx = await setup(t);
  const id = await seedCluster(ctx, 'sigA', SYN_A);
  const c = ctx.dao.evoCluster(id);
  assert.strictEqual(c.status, 'open');
  assert.strictEqual(c.reviewPass, 1);
  assert.strictEqual(c.synthSummary, '提交前先跑单测');
  assert.strictEqual(c.baseVersion, '1.2.3');
  assert.strictEqual(ctx.stub.runs.length, 1);
  assert.strictEqual(ctx.stub.runs[0].blueprintId, 'evolve-center');
  assert.ok(ctx.stub.local['evolve-center'].absPath.replace(/\\/g, '/').endsWith('center-blueprint/evolve-center'));
  const cwd = ctx.stub.runs[0].cwd;
  const m = JSON.parse(fs.readFileSync(path.join(cwd, 'input', 'manifest.json'), 'utf8'));
  assert.deepStrictEqual([m.schema, m.blueprintId, m.baseVersion, m.nodes], ['evolve-center-input/1', BP, '1.2.3', ['n']]);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'input', 'base', 'n', 'SKILL.md'), 'utf8'), BASE);
  // 第二次处理：中心工作流版本没变 ⇒ 不重装
  const imports = ctx.stub.calls.filter((x) => x === 'POST /_blueprint/import').length;
  await ingest(ctx.baseUrl, [proposal('sigB')]);
  ctx.stub.simulate = simulator((samples) => ({ assign: { assignments: samples.map((x) => ({ sample: x.ref, cluster: 'c' + id })), newClusters: [] } }));
  await ctx.runner.processQueue({});
  const centerImports = ctx.stub.calls.filter((x) => x === 'POST /_blueprint/import').length - imports;
  assert.strictEqual(centerImports, 1, '只多了一次基线副本安装，中心工作流没重装');
});

test('牙齿①：同签名二次入库只加计数，零 LLM（不进队列、不起 run）', async (t) => {
  const ctx = await setup(t);
  const id = await seedCluster(ctx, 'sigA', SYN_A);
  assert.strictEqual(ctx.stub.runs.length, 1);
  await ingest(ctx.baseUrl, [
    proposal('sigA', { installId: 'inst-2', payload: Object.assign({}, proposal('sigA').payload, { runId: 'r2' }) }),
    proposal('sigA', { installId: 'inst-3', payload: Object.assign({}, proposal('sigA').payload, { runId: 'r3' }) }),
    makeEvent({ type: 'bp_patch_verdict', installId: 'inst-2', payload: { signature: 'sigA', verdict: 'applied' } }),
    makeEvent({ type: 'bp_patch_verdict', installId: 'inst-3', payload: { signature: 'sigA', verdict: 'rejected' } }),
  ]);
  const c = ctx.dao.evoCluster(id);
  assert.deepStrictEqual([c.machines, c.runs, c.applied, c.rejected], [3, 3, 1, 1]);
  assert.deepStrictEqual(ctx.dao.evoQueuedBlueprints(), []);
  await ctx.runner.processQueue({});
  assert.strictEqual(ctx.stub.runs.length, 1, '没有新签名 ⇒ 一次 run 都不起');
});

test('裁决先于聚类到达：挂簇时重算补齐批准数', async (t) => {
  const ctx = await setup(t);
  await ingest(ctx.baseUrl, [makeEvent({ type: 'bp_patch_verdict', payload: { signature: 'sigA', verdict: 'applied' } })]);
  const id = await seedCluster(ctx, 'sigA', SYN_A);
  assert.strictEqual(ctx.dao.evoCluster(id).applied, 1);
});

// ---------------- 牙齿 ② ----------------
test('牙齿②：已裁决簇不再出补丁（入库只加计数；LLM 并入新样本也不落合成）', async (t) => {
  const ctx = await setup(t);
  const id = await seedCluster(ctx, 'sigA', SYN_A);
  ctx.dao.evoSetClusterStatus(id, 'rejected', '不该这么改', new Date().toISOString());
  const before = ctx.dao.evoCluster(id);
  // 入库一半：同签名 ⇒ 不排队
  await ingest(ctx.baseUrl, [proposal('sigA', { installId: 'inst-9' })]);
  assert.deepStrictEqual(ctx.dao.evoQueuedBlueprints(), []);
  // 执行一半：新签名被 LLM 并入已驳回簇，且（不守规矩地）给它写了合成文件
  await ingest(ctx.baseUrl, [proposal('sigC', { installId: 'inst-8' })]);
  ctx.stub.simulate = simulator((samples, clusters) => {
    assert.strictEqual(clusters.find((c) => c.ref === 'c' + id).status, 'rejected', '输入里带着已裁决簇供并入');
    return { assign: { assignments: samples.map((x) => ({ sample: x.ref, cluster: 'c' + id })), newClusters: [] },
      synth: { ['c' + id]: SYN_B }, review: [{ ref: 'c' + id, pass: true, flags: [] }] };
  });
  await ctx.runner.processQueue({});
  const after = ctx.dao.evoCluster(id);
  assert.strictEqual(after.status, 'rejected');
  assert.strictEqual(after.synthText, before.synthText, '合成补丁没有被改写');
  assert.strictEqual(after.machines, 3, '只加计数');
  assert.deepStrictEqual(ctx.dao.evoQueuedBlueprints(), []);
});

// ---------------- 失败重试 ----------------
test('中心 run 失败：样本退回队列，第二次再败标 failed；可手动重新排队', async (t) => {
  const ctx = await setup(t, { outcome: 'halted' });
  await ingest(ctx.baseUrl, [proposal('sigA')]);
  await ctx.runner.processQueue({});
  assert.deepStrictEqual(ctx.dao.evoQueuedCount(), [{ bpId: BP, n: 1 }]);
  await ctx.runner.processQueue({});
  assert.deepStrictEqual(ctx.dao.evoQueuedCount(), []);
  assert.deepStrictEqual(ctx.dao.evoFailedCount(), [{ bpId: BP, n: 1 }]);
  const q = await getJson(ctx.baseUrl, '/v1/evolve/queue');
  assert.strictEqual(q.json.data.rows[0].status, 'failed');
  assert.match(q.json.data.rows[0].error, /halted/);
  assert.strictEqual(ctx.dao.evoRequeueFailed(BP), 1);
  assert.deepStrictEqual(ctx.dao.evoQueuedCount(), [{ bpId: BP, n: 1 }]);
});

test('合成补丁在基线上套不上 ⇒ 标红 anchor（审查说通过也不算通过）', async (t) => {
  const ctx = await setup(t);
  const id = await seedCluster(ctx, 'sigA', formatSynth('x', [{ find: '不存在的原文\n', replace: 'y\n' }]));
  const c = ctx.dao.evoCluster(id);
  assert.strictEqual(c.reviewPass, 0);
  assert.strictEqual(c.reviewFlags, 'anchor');
});

// ---------------- 牙齿 ③ + 推送 ----------------
async function adoptedPair(ctx) {
  const a = await seedCluster(ctx, 'sigA', SYN_A);
  const b = await seedCluster(ctx, 'sigB', SYN_B);
  const ts = new Date().toISOString();
  ctx.dao.evoSetClusterStatus(a, 'adopted', null, ts);
  ctx.dao.evoSetClusterStatus(b, 'adopted', null, ts);
  return [a, b];
}

test('牙齿③：推送多簇合一分支、版本 +1（副本 X-evo 上打补丁，asId 推成 X）', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await adoptedPair(ctx);
  const r = await basketOf(ctx).push(BP, 'admin');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(ctx.stub.publishes.length, 1, '一次 publish');
  const p = ctx.stub.publishes[0];
  assert.deepStrictEqual([p.id, p.asId, p.version, p.name, p.author], [BP + '-evo', BP, '1.2.4', 'mk', 'admin']);
  assert.match(p.message, new RegExp('#' + a + ' ')); assert.match(p.message, new RegExp('#' + b + ' '));
  const w = ctx.stub.writes.filter((x) => x.id === BP + '-evo');
  assert.strictEqual(w.length, 1, '同节点两簇合成一次写回');
  assert.ok(w[0].content.includes('3. 跑单测\n4. 提交\n') && w[0].content.includes('1. 读需求并列出验收点\n'));
  assert.deepStrictEqual(ctx.stub.local[BP + '-evo'].market, { type: 'market', name: 'mk', id: BP, installAs: BP + '-evo' });
  for (const id of [a, b]) {
    const c = ctx.dao.evoCluster(id);
    assert.deepStrictEqual([c.status, c.branch], ['pushed', 'publish/' + BP + '-1.2.4']);
  }
});

test('推送：市场比目录缓存新 ⇒ 按 marketVersion +1 重试一次；在新版上打不上的簇退回重新合成', async (t) => {
  const ctx = await setup(t, { publishPlan: [{ status: 409, body: { ok: false, code: 'version-not-bumped', marketVersion: '1.2.5' } }] });
  const [a, b] = await adoptedPair(ctx);
  const c3 = await seedCluster(ctx, 'sigZ', formatSynth('z', [{ find: '2. 写代码\n', replace: '2. 写代码（小步）\n' }]));
  ctx.dao.evoSetClusterStatus(c3, 'adopted', null, new Date().toISOString());
  ctx.stub.marketFiles = { 'skills/n/SKILL.md': BASE.replace('2. 写代码\n', '2. 编码\n') };   // 市场新版改掉了锚点
  const { baseUrl } = ctx;
  const res = await postJson(baseUrl, '/v1/evolve/push/' + BP, {});
  // 门禁关（authGate:false）⇒ requireAdmin 拒；走 basket 直调验证行为
  assert.strictEqual(res.status, 403);
  const basket = basketOf(ctx);
  const r = await basket.push(BP, 'admin');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(ctx.stub.publishes.map((p) => p.version), ['1.2.4', '1.2.6']);
  assert.deepStrictEqual([r.pushed.sort(), r.skipped], [[a, b].sort(), [c3]]);
  const z = ctx.dao.evoCluster(c3);
  assert.deepStrictEqual([z.status, z.resynth], ['open', 1]);
  assert.deepStrictEqual(ctx.dao.evoQueuedBlueprints(), [BP], '退回的簇让该蓝图下个窗口重新进批');
});

test('不在目标市场 ⇒ 推送 409 not-in-market；导出补丁可 git apply', async (t) => {
  const ctx = await setup(t, { catalog: [] });
  ctx.stub.catalog = [{ id: BP, version: '1.2.3' }];   // 先让 seed 用市场基线建簇
  const [a] = await adoptedPair(ctx);
  ctx.stub.catalog = [];
  ctx.stub.local[BP] = { files: { 'blueprint.json': JSON.stringify({ id: BP, version: '0.9.0' }), 'skills/n/SKILL.md': BASE } };
  const basket = basketOf(ctx);
  const r = await basket.push(BP, 'admin');
  assert.deepStrictEqual([r.ok, r.status, r.code], [false, 409, 'not-in-market']);
  const ex = await basket.exportPatch(BP, 'admin');
  assert.strictEqual(ex.ok, true);
  assert.match(ex.text, new RegExp('# .*#' + a + ' '));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-apply-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'blueprints', BP, 'skills', 'n'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'blueprints', BP, 'skills', 'n', 'SKILL.md'), BASE);
  fs.writeFileSync(path.join(repo, 'x.patch'), ex.text);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['apply', 'x.patch'], { cwd: repo });
  // Windows 开发机 core.autocrlf=true ⇒ git apply 写出 CRLF，比内容不比换行
  const after = fs.readFileSync(path.join(repo, 'blueprints', BP, 'skills', 'n', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(after.includes('3. 跑单测\n4. 提交\n') && after.includes('1. 读需求并列出验收点\n'));
  assert.strictEqual(ctx.dao.evoCluster(a).status, 'adopted', '导出不改簇状态');
});

// ---------------- 框架问题 / 留出 ----------------
test('框架问题：按签名聚合次数 / 机器 / 事后通过；标记修复后新版本再报 ⇒ 回归', async (t) => {
  const ctx = await setup(t);
  const fw = (inst, ver, passed, count) => makeEvent({ type: 'framework_issue', installId: inst, appVersion: ver,
    payload: { signature: 'fw1', category: 'guard', ruleOrCode: 'asset', sample: 'edit skills/n/SKILL.md', nodeId: 'n', blueprintId: BP, count, passedAfter: passed } });
  await ingest(ctx.baseUrl, [fw('i1', '1.4.0', true, 2), fw('i2', '1.4.0', false, 1), fw('i2', '1.4.0', null, 1)]);
  let row = ctx.dao.evoFwList().rows[0];
  assert.deepStrictEqual([row.count, row.reports, row.machines, row.judged, row.passed], [4, 3, 2, 2, 1]);
  ctx.dao.evoFwSetFixed('fw1', '1.5.0');
  await ingest(ctx.baseUrl, [fw('i3', '1.4.9', true, 1)]);
  assert.strictEqual(ctx.dao.evoFwList().rows[0].regressedVersion, null, '旧版本客户端再报不算回归');
  await ingest(ctx.baseUrl, [fw('i3', '1.5.1', true, 1)]);
  row = ctx.dao.evoFwList().rows[0];
  assert.strictEqual(row.regressedVersion, '1.5.1');
});

test('留出对照：bp_run_end.nodes 按臂累加；任一臂 <30 不给结论；够了给置信区间', async (t) => {
  const ctx = await setup(t);
  const end = (nodes) => makeEvent({ type: 'bp_run_end', payload: { blueprintId: BP, runId: 'r', status: 'done', nodes } });
  await ingest(ctx.baseUrl, [
    end([{ nodeId: 'n', injected: true, holdout: false, firstPass: true, rewinds: 0 }]),
    end([{ nodeId: 'n', injected: false, holdout: true, firstPass: false, rewinds: 2 }]),
    end([{ nodeId: 'n', injected: false, holdout: false, firstPass: true, rewinds: 0 }]),   // 无可注入：不计
  ]);
  const d = (await getJson(ctx.baseUrl, '/v1/evolve/holdout')).json.data;
  assert.strictEqual(d.rows.length, 1);
  assert.deepStrictEqual([d.rows[0].inj.n, d.rows[0].hold.n, d.rows[0].hold.avgRewinds, d.rows[0].verdict], [1, 1, 2, 'insufficient']);
  const rows = [
    { bpId: BP, nodeId: 'n', arm: 'inj', n: 100, firstPass: 80, rewinds: 10 },
    { bpId: BP, nodeId: 'n', arm: 'hold', n: 40, firstPass: 16, rewinds: 30 },
  ];
  const h = holdoutCompare(rows)[0];
  assert.strictEqual(h.verdict, 'helps');
  assert.ok(Math.abs(h.diff - 0.4) < 1e-9 && h.ci[0] > 0);
});

// ---------------- 鉴权 / 审计 ----------------
async function req(baseUrl, method, p, o) {
  const res = await fetch(baseUrl + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, (o && o.headers) || {}),
    body: o && o.body ? JSON.stringify(o.body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('鉴权：写口未登录 401、普通用户 403、管理员成功并记审计；公开配置 GET 形状不变', async (t) => {
  const stub = await stubCancong(t);
  const ctx = await makeApp(t, { auth: true, cancongUrl: stub.url });
  const login = async (u, p) => (await req(ctx.baseUrl, 'POST', '/v1/auth/login', { body: { username: u, password: p } })).json.data.token;
  const H = { authorization: 'Bearer ' + await login('admin', 'admin123') };
  await req(ctx.baseUrl, 'POST', '/v1/auth/users', { headers: H, body: { username: 'alice', password: 'alice123' } });
  const A = { authorization: 'Bearer ' + await login('alice', 'alice123') };
  const cid = ctx.dao.evoInsertCluster({ bpId: BP, nodeId: 'n', title: 't', now: new Date().toISOString() });

  assert.strictEqual((await req(ctx.baseUrl, 'POST', '/v1/evolve/clusters/' + cid + '/adopt')).status, 401);
  assert.strictEqual((await req(ctx.baseUrl, 'POST', '/v1/evolve/clusters/' + cid + '/adopt', { headers: A })).status, 403);
  assert.strictEqual((await req(ctx.baseUrl, 'GET', '/v1/evolve/clusters', { headers: A })).status, 200, '读口登录即可');
  assert.strictEqual((await req(ctx.baseUrl, 'POST', '/v1/evolve/clusters/' + cid + '/reject', { headers: H })).status, 400, '驳回必须写理由');
  assert.strictEqual((await req(ctx.baseUrl, 'POST', '/v1/evolve/clusters/' + cid + '/adopt', { headers: H })).status, 200);
  assert.strictEqual(ctx.dao.evoCluster(cid).status, 'adopted');
  assert.strictEqual((await req(ctx.baseUrl, 'POST', '/v1/evolve/clusters/' + cid + '/adopt', { headers: H })).status, 409, '非法迁移');

  const put = await req(ctx.baseUrl, 'PUT', '/v1/config/evolve', { headers: H, body: { uploadWhitelist: [BP], holdoutP: 0.2, windowHour: 4, market: { name: 'mk2', url: 'https://x.invalid/m.git' } } });
  assert.strictEqual(put.status, 200);
  assert.strictEqual((await req(ctx.baseUrl, 'PUT', '/v1/config/evolve', { headers: H, body: { uploadWhitelist: [], windowHour: 24 } })).status, 400);
  const pub = await req(ctx.baseUrl, 'GET', '/v1/config/evolve');
  assert.deepStrictEqual(Object.keys(pub.json).sort(), ['holdoutP', 'ok', 'uploadWhitelist', 'version'], '客户端契约不外露中心字段');
  assert.strictEqual((await req(ctx.baseUrl, 'GET', '/v1/evolve/config', { headers: A })).status, 403);
  const full = (await req(ctx.baseUrl, 'GET', '/v1/evolve/config', { headers: H })).json.data;
  assert.deepStrictEqual([full.config.windowHour, full.config.market.name], [4, 'mk2']);
  const acts = full.audit.rows.map((r) => r.action);
  assert.deepStrictEqual(acts, ['config', 'cluster-adopt']);
  assert.deepStrictEqual([full.audit.rows[0].user, full.audit.rows[0].detail.after.windowHour, full.audit.rows[0].detail.before.windowHour], ['admin', 4, 2]);
  // 只改白名单（批 3 的调用方）⇒ 窗口与市场沿用
  await req(ctx.baseUrl, 'PUT', '/v1/config/evolve', { headers: H, body: { uploadWhitelist: [] } });
  const kept = (await req(ctx.baseUrl, 'GET', '/v1/evolve/config', { headers: H })).json.data.config;
  assert.deepStrictEqual([kept.windowHour, kept.market.name], [4, 'mk2']);

  assert.strictEqual((await req(ctx.baseUrl, 'POST', '/v1/evolve/queue/run', { headers: A })).status, 403);
  assert.strictEqual((await req(ctx.baseUrl, 'POST', '/v1/evolve/push/' + BP, { headers: A })).status, 403);
  assert.strictEqual((await req(ctx.baseUrl, 'GET', '/v1/evolve/export/' + BP, { headers: A })).status, 403);
});

// ---------------- 中心工作流规范检查（跨仓：找得到 TechDemos 才跑） ----------------
test('中心工作流过 TechDemos 蓝图规范检查（与市场推送同判据）', (t) => {
  const td = [process.env.TECHDEMOS_DIR, path.join(__dirname, '..', '..', 'TechDemos')].filter(Boolean)
    .find((d) => fs.existsSync(path.join(d, 'server-blueprint', 'import.js')));
  if (!td) { t.skip('兄弟仓 TechDemos 不在（设 TECHDEMOS_DIR 指过去）'); return; }
  const v = require(path.join(td, 'server-blueprint', 'import.js')).validateStagedDir(path.join(__dirname, '..', 'center-blueprint', 'evolve-center'));
  assert.deepStrictEqual([v.ok, v.violations, (v.lint || []).filter((l) => l.level === 'error')], [true, [], []]);
});

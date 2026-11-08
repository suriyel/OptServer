'use strict';
// 自进化中心拆出后的本服务面（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §6）：
// v7 迁移（老 v6 库升上来：五表删、fw_issues 留、机器数回填进 fw_issue_machines）、框架问题入库 + 回归、
// 自进化样本不再进本服务、服务发现三取值（免登录）、门禁白名单不再放 /v1/config/evolve。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { openDb, MIGRATIONS } = require('../lib/db');
const { ingestBatch } = require('../lib/ingest');
const { parseEvolve } = require('../lib/discovery');
const { makeApp, makeEvent, postJson } = require('./helpers');

const NOW = new Date('2026-11-08T03:00:00.000Z');

test('★ v7：v6 老库（含自进化数据）升上来 ⇒ 五表删、fw_issues 留、机器数回填、evolve_config 删；makeDao 不抛', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-v7-'));
  const p = path.join(dir, 'old.db');
  // 先造一个 v6 形态的老库：跑真迁移序列的前 6 步，再塞自进化数据
  const db6 = new Database(p);
  for (const m of MIGRATIONS.filter((x) => x.version <= 6)) db6.exec(m.sql);
  db6.pragma('user_version = 6');
  db6.prepare("INSERT INTO evolve_samples (type, signature, install_id, status) VALUES ('framework_issue','fw1','i1','done'),('framework_issue','fw1','i2','done'),('bp_patch_proposal','s1','i1','queued')").run();
  db6.prepare("INSERT INTO fw_issues (signature, count, machines, fixed_in) VALUES ('fw1', 5, 2, '1.5.0')").run();
  db6.prepare("INSERT INTO meta (key, value) VALUES ('evolve_config', '{}'), ('keep', 'x')").run();
  db6.close();

  const { db, dao, close } = openDb(p);
  // Windows：先关库再删目录（打开中的 db 文件持锁），合并到同一个 t.after
  t.after(() => { close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  assert.strictEqual(db.pragma('user_version', { simple: true }), 7);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const x of ['evolve_samples', 'evolve_clusters', 'evolve_batches', 'evolve_holdout', 'evolve_audit']) assert.ok(!tables.includes(x), x + ' 应被删');
  assert.ok(tables.includes('fw_issues') && tables.includes('fw_issue_machines'));
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM fw_issue_machines').get().c, 2, '★ 不回填 ⇒ 下次入库机器数从 0 重数');
  assert.strictEqual(dao.fwList().rows[0].fixedIn, '1.5.0', '修复标记随 fw_issues 保留');
  assert.strictEqual(dao.metaGet('evolve_config'), null);
  assert.strictEqual(dao.metaGet('keep'), 'x');
  // 再来一条同签名新机器：机器数 = 2 + 1（走 fw_issue_machines）
  ingestBatch(dao, [makeEvent({ type: 'framework_issue', installId: 'i3', appVersion: '1.4.0', payload: { signature: 'fw1', count: 1 } })], NOW);
  assert.strictEqual(dao.fwList().rows[0].machines, 3);
});

test('★ 框架问题：按签名聚合次数 / 机器 / 事后通过；标记修复后新版本再报 ⇒ 回归（旧版本再报不算）', async (t) => {
  const { baseUrl, dao } = await makeApp(t, { auth: true });
  const login = await (await fetch(baseUrl + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json();
  const fix = (sig, version) => fetch(baseUrl + '/v1/fw-issues/' + sig + '/fixed', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + login.data.token }, body: JSON.stringify({ version }) });
  const fw = (inst, ver, passed, count) => makeEvent({ type: 'framework_issue', installId: inst, appVersion: ver,
    payload: { signature: 'fw1', category: 'guard', ruleOrCode: 'asset', sample: 'edit skills/n/SKILL.md', nodeId: 'n', blueprintId: 'bp', count, passedAfter: passed } });
  await postJson(baseUrl, '/v1/events', { events: [fw('i1', '1.4.0', true, 2), fw('i2', '1.4.0', false, 1), fw('i2', '1.4.0', null, 1)] });
  let row = dao.fwList().rows[0];
  assert.deepStrictEqual([row.count, row.reports, row.machines, row.judged, row.passed], [4, 3, 2, 2, 1]);
  assert.strictEqual((await fix('fw1', '1.5')).status, 400);
  assert.strictEqual((await fix('nope', '1.5.0')).status, 404);
  assert.strictEqual((await fix('fw1', '1.5.0')).status, 200);
  assert.strictEqual((await fetch(baseUrl + '/v1/fw-issues')).status, 401, '读口在门禁内');
  await postJson(baseUrl, '/v1/events', { events: [fw('i3', '1.4.9', true, 1)] });
  assert.strictEqual(dao.fwList().rows[0].regressedVersion, null, '旧版本客户端再报不算回归');
  await postJson(baseUrl, '/v1/events', { events: [fw('i3', '1.5.1', true, 1)] });
  row = dao.fwList().rows[0];
  assert.strictEqual(row.regressedVersion, '1.5.1');
});

test('★ 自进化样本不再进本服务：bp_patch_* / evolve_run_summary 计未知类型、不建任何自进化表', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-split-'));
  const h = openDb(path.join(dir, 't.db'));
  t.after(() => { h.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  ingestBatch(h.dao, [
    makeEvent({ type: 'bp_patch_proposal', payload: { signature: 's' } }),
    makeEvent({ type: 'evolve_run_summary', payload: { blueprintId: 'bp', nodes: [] } }),
  ], NOW);
  assert.strictEqual(h.dao.qUnknownTypes(), 2, '★ 漂移要自己叫出来（总览页出卡）');
});

test('服务发现：OPS_EVOLVE 三取值 + 非法值按「没有」', () => {
  assert.deepStrictEqual(parseEvolve(':5901'), { port: 5901 });
  assert.deepStrictEqual(parseEvolve('http://10.0.0.9:5901/x'), { url: 'http://10.0.0.9:5901' });
  assert.strictEqual(parseEvolve(''), null);
  assert.strictEqual(parseEvolve(undefined), null);
  assert.strictEqual(parseEvolve(':0'), null);
  assert.strictEqual(parseEvolve('ftp://x'), null);
  assert.strictEqual(parseEvolve('not a url'), null);
});

test('★ 服务发现免登录（门禁白名单）；/v1/config/evolve 不再免登录（已拆走）', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true, evolve: ':5901' });
  const r = await fetch(baseUrl + '/v1/discovery');
  assert.strictEqual(r.status, 200, '★ 客户端没有账号：discovery 必须在白名单里');
  assert.deepStrictEqual(await r.json(), { schemaVersion: 1, services: { evolve: { port: 5901 } } });
  assert.strictEqual((await fetch(baseUrl + '/v1/config/evolve')).status, 401);
  const none = await makeApp(t, { auth: true, evolve: '' });
  assert.deepStrictEqual((await (await fetch(none.baseUrl + '/v1/discovery')).json()).services, { evolve: null });
});

test('★ login.html 回跳只认同主机名（防开放重定向）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  const m = /\/\* safeNext:begin[\s\S]*?\*\/([\s\S]*?)\/\* safeNext:end \*\//.exec(html);
  assert.ok(m, 'login.html 里找不到 safeNext 标记段');
  const safeNext = new Function(m[1] + '; return safeNext;')();
  const loc = new URL('http://10.169.74.11:5900/login.html?next=x');
  assert.strictEqual(safeNext('http://10.169.74.11:5901/#queue', loc), 'http://10.169.74.11:5901/#queue', '同主机不同端口 = 共部署自进化');
  assert.strictEqual(safeNext('/#overview', loc), 'http://10.169.74.11:5900/#overview');
  assert.strictEqual(safeNext('http://evil.example/', loc), '/', '★ 去掉主机校验这里就跳走了');
  assert.strictEqual(safeNext('//evil.example/x', loc), '/');
  assert.strictEqual(safeNext('javascript:alert(1)', loc), '/');
  assert.strictEqual(safeNext(null, loc), '/');
});

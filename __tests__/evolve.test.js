'use strict';
// 蓝图自进化批 3（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §4）：三类样本事件入库、
// 上报配置 GET（免登录）/ PUT（仅管理员）、gzip 整批上报入库（客户端 sender 整批 gzip，§4.5）。

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');

const { openTempDb, makeApp, makeEvent } = require('./helpers');
const { ingestBatch } = require('../lib/ingest');
const { localDay } = require('../lib/time-utils');

const NOW = new Date('2026-07-02T03:00:00.000Z');

function req(baseUrl, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + p);
    const headers = Object.assign({}, opts.headers);
    let payload;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (opts.body !== undefined) payload = JSON.stringify(opts.body);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}
const login = async (baseUrl, u, p) => (await req(baseUrl, 'POST', '/v1/auth/login', { body: { username: u, password: p } })).json.data.token;
const bearer = (token) => ({ authorization: 'Bearer ' + token });

test('★ 三类自进化样本：进 KNOWN_TYPES + deltasOf 有 case ⇒ 当日行建出、不计未知类型、payload 原样留存', (t) => {
  const { db, dao } = openTempDb(t);
  const r = ingestBatch(dao, [
    makeEvent({ type: 'bp_patch_proposal', payload: { signature: 'sig1', blueprintId: 'bp', nodeId: 'dev', diff: '--- FIND\na\n+++ REPLACE\nb' } }),
    makeEvent({ type: 'bp_patch_verdict', payload: { signature: 'sig1', verdict: 'applied' } }),
    makeEvent({ type: 'framework_issue', payload: { signature: 'fw1', category: 'guard', ruleOrCode: 'readonly', count: 3, passedAfter: true } }),
  ], NOW);
  assert.deepStrictEqual(r, { accepted: 3, dup: 0, rejected: 0 });
  assert.strictEqual(dao.qUnknownTypes(), 0, '★ 没进 KNOWN_TYPES 的话这里是 3');
  const row = db.prepare('SELECT * FROM daily_user WHERE day = ? AND install_id = ?').get(localDay(NOW), 'inst-1');
  assert.ok(row, '★ deltasOf 没有 case ⇒ default:null ⇒ 当日行不建');
  assert.strictEqual(row.failures, 0, '框架墙样本不是用户失败');
  assert.strictEqual(row.last_at, null, '不进 RECENCY_TYPES：样本不是「使用」');
  const p = JSON.parse(db.prepare("SELECT payload FROM events WHERE type = 'bp_patch_proposal'").get().payload);
  assert.strictEqual(p.diff, '--- FIND\na\n+++ REPLACE\nb');
});

test('★ 上报配置：GET 免登录、缺省空白名单 + 0.1；PUT 未登录 401、管理员写入后 version+1、非法值 400', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const g0 = await req(baseUrl, 'GET', '/v1/config/evolve');
  assert.strictEqual(g0.status, 200, '★ 客户端没有账号：GET 必须在门禁白名单里');
  assert.deepStrictEqual(g0.json, { ok: true, uploadWhitelist: [], holdoutP: 0.1, version: 0 });

  assert.strictEqual((await req(baseUrl, 'PUT', '/v1/config/evolve', { body: { uploadWhitelist: ['bp'] } })).status, 401);
  const H = bearer(await login(baseUrl, 'admin', 'admin123'));
  const bad = await req(baseUrl, 'PUT', '/v1/config/evolve', { headers: H, body: { uploadWhitelist: ['bad id!'] } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await req(baseUrl, 'PUT', '/v1/config/evolve', { headers: H, body: { uploadWhitelist: [], holdoutP: 0.9 } })).status, 400);
  const ok = await req(baseUrl, 'PUT', '/v1/config/evolve', { headers: H, body: { uploadWhitelist: ['bp-a', 'bp-a', 'bp-b'], holdoutP: 0.2 } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json, { ok: true, uploadWhitelist: ['bp-a', 'bp-b'], holdoutP: 0.2, version: 1 });
  const g1 = await req(baseUrl, 'GET', '/v1/config/evolve');
  assert.deepStrictEqual(g1.json, { ok: true, uploadWhitelist: ['bp-a', 'bp-b'], holdoutP: 0.2, version: 1 });
});

test('上报配置 PUT：普通用户 403', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const H = bearer(await login(baseUrl, 'admin', 'admin123'));
  await req(baseUrl, 'POST', '/v1/auth/users', { headers: H, body: { username: 'alice', password: 'pw123456' } });
  const A = bearer(await login(baseUrl, 'alice', 'pw123456'));
  assert.strictEqual((await req(baseUrl, 'PUT', '/v1/config/evolve', { headers: A, body: { uploadWhitelist: [] } })).status, 403);
});

test('★ gzip 整批上报（Content-Encoding: gzip）经真 HTTP 入库——express.json 默认 inflate，钉死不靠推理', async (t) => {
  const { baseUrl, db } = await makeApp(t);
  const raw = zlib.gzipSync(JSON.stringify({ events: [
    makeEvent({ type: 'framework_issue', payload: { signature: 'fw-gz', category: 'guard', count: 1 } }),
  ] }));
  const r = await req(baseUrl, 'POST', '/v1/events', { raw, headers: { 'content-encoding': 'gzip' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.accepted, 1);
  const p = JSON.parse(db.prepare("SELECT payload FROM events WHERE type = 'framework_issue'").get().payload);
  assert.strictEqual(p.signature, 'fw-gz');
});

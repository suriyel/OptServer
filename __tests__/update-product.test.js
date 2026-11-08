'use strict';
// update-product.test.js —— 发布面的产品维度（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §5.6）：
// ?product=evolve 是自进化服务 cancong-evolve 的 Linux 预构建包：独立版本号 / index.json / 发布区（releases/evolve/），
// 不进蚕丛的 manifest；缺省 product = cancong ⇒ 现有客户端与看板零感知。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const { makeApp, postJson, getJson } = require('./helpers');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gz = () => zlib.gzipSync(crypto.randomBytes(2048));
const auth = (tok, extra) => Object.assign({ authorization: 'Bearer ' + tok }, extra || {});

async function login(baseUrl) {
  return (await postJson(baseUrl, '/v1/auth/login', { username: 'admin', password: 'admin123' })).json.data.token;
}
async function upload(baseUrl, tok, q, buf) {
  const res = await fetch(`${baseUrl}/v1/update/upload?${q}`, { method: 'POST', headers: auth(tok, { 'content-type': 'application/octet-stream' }), body: buf });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function publish(baseUrl, tok, product, version) {
  const res = await fetch(`${baseUrl}/v1/update/publish${product ? '?product=' + product : ''}`, {
    method: 'POST', headers: auth(tok, { 'content-type': 'application/json' }), body: JSON.stringify({ version, notes: '', minSupported: '' }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('★ evolve 产品：独立发布（x64 必需、规范名 cancong-evolve-*、可下载），不进蚕丛 manifest', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const tok = await login(baseUrl);
  const buf = gz();
  assert.strictEqual((await upload(baseUrl, tok, 'product=evolve&variant=linux-x64&version=1.0.0&filename=cancong-evolve-1.0.0-linux-x64.tar.gz', buf)).status, 200);
  const r = await publish(baseUrl, tok, 'evolve', '1.0.0');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const p = r.json.data.published.packages['linux-x64'];
  assert.deepStrictEqual([p.file, p.sha256], ['cancong-evolve-1.0.0-linux-x64.tar.gz', sha256(buf)]);
  assert.deepStrictEqual(Object.keys(r.json.data.published.packages), ['linux-x64']);

  const latest = await getJson(baseUrl, '/v1/update/latest?product=evolve');
  assert.strictEqual(latest.json.version, '1.0.0');
  const dl = await fetch(baseUrl + '/v1/update/download/' + p.file + '?product=evolve');
  assert.strictEqual(sha256(Buffer.from(await dl.arrayBuffer())), sha256(buf));
  // ★ 蚕丛的 feed 不受影响（客户端不带 product）
  assert.strictEqual((await fetch(baseUrl + '/v1/update/latest')).status, 204, '★ evolve 包混进蚕丛 manifest ⇒ 蚕丛客户端看到「有新版」');
  assert.strictEqual((await fetch(baseUrl + '/v1/update/download/' + p.file)).status, 404);
});

test('evolve 产品：x64 缺席不准发布；exe 变体不认；未知产品 400；草稿区按产品分开', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const tok = await login(baseUrl);
  await upload(baseUrl, tok, 'product=evolve&variant=linux-arm64&version=1.0.1&filename=cancong-evolve-1.0.1-linux-arm64.tar.gz', gz());
  const r = await publish(baseUrl, tok, 'evolve', '1.0.1');
  assert.strictEqual(r.status, 400, '缺必需的 x64');
  assert.strictEqual((await upload(baseUrl, tok, 'product=evolve&variant=slim&version=1.0.1&filename=x.exe', gz())).status, 400);
  assert.strictEqual((await fetch(baseUrl + '/v1/update/latest?product=nope')).status, 400);
  const evo = await (await fetch(baseUrl + '/v1/update/drafts?product=evolve', { headers: auth(tok) })).json();
  const can = await (await fetch(baseUrl + '/v1/update/drafts', { headers: auth(tok) })).json();
  assert.strictEqual(evo.data.drafts.length, 1);
  assert.strictEqual(can.data.drafts.length, 0, '草稿区按产品隔离');
});

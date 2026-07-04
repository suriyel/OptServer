'use strict';
// server.test.js —— 装配层：探活、JSON 404、坏 body 兜底、静态看板、require 不 listen

const test = require('node:test');
const assert = require('node:assert');

const { makeApp, getJson, postJson } = require('./helpers');

test('/healthz → 200 { ok: true }', async (t) => {
  const { baseUrl } = await makeApp(t);
  const { status, json } = await getJson(baseUrl, '/healthz');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(json, { ok: true });
});

test('/v1 未知路由 → JSON 404 { ok: false }', async (t) => {
  const { baseUrl } = await makeApp(t);
  const { status, json } = await getJson(baseUrl, '/v1/nope');
  assert.strictEqual(status, 404);
  assert.strictEqual(json.ok, false);
});

test('坏 JSON body → 400 { ok: false }（错误兜底中间件）', async (t) => {
  const { baseUrl } = await makeApp(t);
  const { status, json } = await postJson(baseUrl, '/v1/events', '{broken');
  assert.strictEqual(status, 400);
  assert.strictEqual(json.ok, false);
});

test('GET / → 看板 index.html', async (t) => {
  const { baseUrl } = await makeApp(t);
  const res = await fetch(baseUrl + '/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('require server.js 不 listen（require.main 守卫）', () => {
  const mod = require('../server'); // helpers 已 require 过，这里验证导出形状且无副作用端口
  assert.strictEqual(typeof mod.createApp, 'function');
});

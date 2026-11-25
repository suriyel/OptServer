'use strict';
// 需求研发看板的身份面（TechDemos docs/REQ-FLOW-DESIGN.md §8 / §12 兼容条款）：
// 心跳 / 上线事件可选带 payload.welinkUid ⇒ installs.welink_uid；★ 老格式心跳照常、坏 UID 绝不拒事件；
// GET /v1/internal/persons 只认回环 / OPS_EVOLVE 主机（或共享密钥），门禁开着也能被 evolve 调到。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openTempDb, listenApp, makeEvent } = require('./helpers');
const { ingestBatch } = require('../lib/ingest');
const { createApp } = require('../server');

const NOW = new Date('2026-11-12T08:00:00Z');
const row = (db, id) => db.prepare('SELECT last_seen lastSeen, welink_uid uid FROM installs WHERE install_id = ?').get(id);

test('★ 老格式心跳（无 UID）照常更新 last_seen；带 UID 落库（小写）；后续不带不抹；坏 UID 忽略不拒', (t) => {
  const { db, dao } = openTempDb(t);
  let r = ingestBatch(dao, [makeEvent({ type: 'instance_heartbeat', installId: 'i1', payload: { liveSessions: 1 } })], NOW);
  assert.strictEqual(r.accepted, 1);
  assert.deepStrictEqual(row(db, 'i1'), { lastSeen: NOW.toISOString(), uid: null });
  r = ingestBatch(dao, [makeEvent({ type: 'instance_online', installId: 'i1', payload: { port: 5173, welinkUid: 'L00583895' } })], NOW);
  assert.strictEqual(r.accepted, 1);
  assert.strictEqual(row(db, 'i1').uid, 'l00583895');
  const later = new Date(NOW.getTime() + 300000);
  r = ingestBatch(dao, [makeEvent({ type: 'instance_heartbeat', installId: 'i1', payload: { liveSessions: 0 } }),
    makeEvent({ type: 'instance_heartbeat', installId: 'i2', payload: { welinkUid: 'not a uid' } }),
    makeEvent({ type: 'instance_heartbeat', installId: 'i3', payload: { welinkUid: 12345 } })], later);
  assert.strictEqual(r.accepted, 3, '坏 UID 绝不拒事件');
  assert.strictEqual(r.rejected, 0);
  assert.deepStrictEqual(row(db, 'i1'), { lastSeen: later.toISOString(), uid: 'l00583895' });
  assert.strictEqual(row(db, 'i2').uid, null);
  ingestBatch(dao, [makeEvent({ type: 'session_start', installId: 'i2', payload: { welinkUid: 'z00000001' } })], later);
  assert.strictEqual(row(db, 'i2').uid, null, '只认心跳 / 上线事件');
});

test('/v1/internal/persons：回环 200（门禁开着也免登录）/ 非回环 403；没有共享密钥：环境里留着 OPS_INTERNAL_TOKEN、请求带上它也 403', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-int-'));
  let remote = '127.0.0.1';
  const prevTok = process.env.OPS_INTERNAL_TOKEN;
  process.env.OPS_INTERNAL_TOKEN = 'sekret';
  t.after(() => { if (prevTok === undefined) delete process.env.OPS_INTERNAL_TOKEN; else process.env.OPS_INTERNAL_TOKEN = prevTok; });
  const h = createApp({ dbPath: path.join(dir, 'o.db'), adminPassword: 'admin123', internalRemoteOf: () => remote });
  const { baseUrl } = await listenApp(t, h.app);
  t.after(() => { h.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  ingestBatch(h.dao, [makeEvent({ type: 'instance_heartbeat', installId: 'i9', user: 'zhang', host: 'PC-Z', payload: { welinkUid: 'z00583895' } })], NOW);
  let res = await fetch(baseUrl + '/v1/internal/persons');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.data.map((x) => [x.installId, x.user, x.host, x.welinkUid]), [['i9', 'zhang', 'PC-Z', 'z00583895']]);
  remote = '10.1.2.3';
  assert.strictEqual((await fetch(baseUrl + '/v1/internal/persons')).status, 403);
  assert.strictEqual((await fetch(baseUrl + '/v1/internal/persons', { headers: { 'x-ops-internal-token': 'sekret' } })).status, 403, '共享密钥已取消');
  // 门禁照旧挡住看板数据接口
  assert.strictEqual((await fetch(baseUrl + '/v1/installs')).status, 401);
});

test('/v1/internal/persons：OPS_EVOLVE 指向的主机放行（IP 与主机名）；别的来源 403 且回包带看到的来源地址', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-int-'));
  const apps = [];
  t.after(() => { for (const h of apps) h.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  let remote = '::ffff:10.0.0.8';
  // IP 形式：不查 DNS；IPv4 映射的 IPv6 来源也认
  const a = createApp({ dbPath: path.join(dir, 'a.db'), adminPassword: 'admin123', evolve: 'http://10.0.0.8:5901',
    internalRemoteOf: () => remote, internalLookup: () => { throw new Error('IP 不该查 DNS'); } });
  apps.push(a);
  const A = (await listenApp(t, a.app)).baseUrl;
  assert.strictEqual((await fetch(A + '/v1/internal/persons')).status, 200);
  remote = '10.0.0.9';
  let res = await fetch(A + '/v1/internal/persons');
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(await res.json(), { ok: false, error: 'forbidden', remote: '10.0.0.9' });
  // 主机名形式：解析出的任一地址都认
  const asked = [];
  const b = createApp({ dbPath: path.join(dir, 'b.db'), adminPassword: 'admin123', evolve: 'http://evolve.lan:5901',
    internalRemoteOf: () => remote, internalLookup: (h, o, cb) => { asked.push(h); cb(null, [{ address: '10.0.0.20', family: 4 }, { address: '10.0.0.9', family: 4 }]); } });
  apps.push(b);
  const B = (await listenApp(t, b.app)).baseUrl;
  assert.strictEqual((await fetch(B + '/v1/internal/persons')).status, 200);
  assert.deepStrictEqual(asked, ['evolve.lan']);
});

test('OPS_EVOLVE 主机名：被拒时距上次解析超过 60 s 才重解析（换 IP 能跟上，不会每次被拒都查 DNS）', async () => {
  const { createEvolveAllow } = require('../lib/internal');
  let now = 0; let addr = '10.0.0.1'; let n = 0;
  const allow = createEvolveAllow('http://evolve.lan:5901', { nowFn: () => now, lookup: (h, o, cb) => { n++; cb(null, [{ address: addr }]); } });
  assert.strictEqual(await allow.allows('10.0.0.1'), true);
  addr = '10.0.0.2';
  assert.strictEqual(await allow.allows('10.0.0.2'), false, '60 s 内不重查');
  assert.strictEqual(n, 1);
  now = 61000;
  assert.strictEqual(await allow.allows('10.0.0.2'), true, '过了 60 s 被拒前重查一次');
  assert.strictEqual(n, 2);
  // 同主机相对端口 / 没设：不放行任何非回环来源
  assert.strictEqual(await createEvolveAllow(':5901').allows('10.0.0.1'), false);
  assert.strictEqual(await createEvolveAllow('').allows('10.0.0.1'), false);
});

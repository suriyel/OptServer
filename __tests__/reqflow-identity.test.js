'use strict';
// 需求研发看板的身份面（TechDemos docs/REQ-FLOW-DESIGN.md §8 / §12 兼容条款）：
// 心跳 / 上线事件可选带 payload.welinkUid ⇒ installs.welink_uid；★ 老格式心跳照常、坏 UID 绝不拒事件；
// GET /v1/internal/persons 只认回环（或共享密钥），门禁开着也能被同机 evolve 调到。

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

test('/v1/internal/persons：回环 200（门禁开着也免登录）/ 非回环 403 / 带对共享密钥 200', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-int-'));
  let remote = '127.0.0.1';
  const h = createApp({ dbPath: path.join(dir, 'o.db'), adminPassword: 'admin123', internalToken: 'sekret', internalRemoteOf: () => remote });
  const { baseUrl } = await listenApp(t, h.app);
  t.after(() => { h.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  ingestBatch(h.dao, [makeEvent({ type: 'instance_heartbeat', installId: 'i9', user: 'zhang', host: 'PC-Z', payload: { welinkUid: 'z00583895' } })], NOW);
  let res = await fetch(baseUrl + '/v1/internal/persons');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.data.map((x) => [x.installId, x.user, x.host, x.welinkUid]), [['i9', 'zhang', 'PC-Z', 'z00583895']]);
  remote = '10.1.2.3';
  assert.strictEqual((await fetch(baseUrl + '/v1/internal/persons')).status, 403);
  assert.strictEqual((await fetch(baseUrl + '/v1/internal/persons', { headers: { 'x-ops-internal-token': 'wrong!' } })).status, 403);
  res = await fetch(baseUrl + '/v1/internal/persons', { headers: { 'x-ops-internal-token': 'sekret' } });
  assert.strictEqual(res.status, 200);
  // 门禁照旧挡住看板数据接口
  assert.strictEqual((await fetch(baseUrl + '/v1/installs')).status, 401);
});

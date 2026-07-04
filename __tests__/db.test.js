'use strict';
// db.test.js —— 唯一 SQL 层：PRAGMA 时序、迁移幂等、DAO 语义

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../lib/db');

// Windows 下必须先 close 再删目录（打开中的 db 文件持锁），故合并到同一个 t.after
function openTempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-db-'));
  const handle = openDb(path.join(dir, 'test.db'));
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return handle;
}

test('新库 PRAGMA：WAL + auto_vacuum=INCREMENTAL + user_version=1', (t) => {
  const { db } = openTempDb(t);
  assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.strictEqual(db.pragma('auto_vacuum', { simple: true }), 2); // 2 = INCREMENTAL
  assert.strictEqual(db.pragma('user_version', { simple: true }), 1);
  assert.strictEqual(db.pragma('synchronous', { simple: true }), 1); // 1 = NORMAL
});

test('重复 openDb：迁移不重跑，数据保留', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-db-'));
  const p = path.join(dir, 'test.db');
  const first = openDb(p);
  first.dao.metaSet('k', 'v1');
  first.close();
  const second = openDb(p); // 已迁移库再打开：DDL 不应重跑（重跑会因表已存在而抛）
  t.after(() => {
    second.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  assert.strictEqual(second.db.pragma('user_version', { simple: true }), 1);
  assert.strictEqual(second.dao.metaGet('k'), 'v1');
});

test('bumpDaily：全 0 调用只建行；重复 bump 累加', (t) => {
  const { db, dao } = openTempDb(t);
  dao.bumpDaily('2026-07-02', 'i1', 'u1', 'h1', {}); // 全 0：仅确保行存在
  let row = db.prepare('SELECT * FROM daily_user').get();
  assert.strictEqual(row.sessions, 0);
  assert.strictEqual(row.heartbeats, 0);

  dao.bumpDaily('2026-07-02', 'i1', 'u1', 'h1', { sessions: 1, sessionMs: 500 });
  dao.bumpDaily('2026-07-02', 'i1', 'u1', 'h1', { sessions: 1, heartbeats: 2 });
  row = db.prepare('SELECT * FROM daily_user').get();
  assert.strictEqual(row.sessions, 2);
  assert.strictEqual(row.session_ms, 500);
  assert.strictEqual(row.heartbeats, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM daily_user').get().c, 1);
});

test('upsertInstall：liveSessions 无值不覆盖、first_seen 不变、last_seen 刷新', (t) => {
  const { db, dao } = openTempDb(t);
  dao.upsertInstall({ installId: 'i1', user: 'u1', host: 'h1', platform: 'win32',
    appVersion: '1.0.0', channel: 'packaged', nowIso: '2026-07-01T01:00:00.000Z', liveSessions: 3 });
  dao.upsertInstall({ installId: 'i1', user: 'u1', host: 'h1', platform: null,
    appVersion: '1.1.0', channel: null, nowIso: '2026-07-02T01:00:00.000Z', liveSessions: null });
  const row = db.prepare('SELECT * FROM installs').get();
  assert.strictEqual(row.first_seen, '2026-07-01T01:00:00.000Z'); // 首见时刻不动
  assert.strictEqual(row.last_seen, '2026-07-02T01:00:00.000Z');  // 每次刷新
  assert.strictEqual(row.live_sessions, 3);                       // null 不覆盖
  assert.strictEqual(row.app_version, '1.1.0');                   // 有值则更新
  assert.strictEqual(row.platform, 'win32');                      // null 不冲掉已知值
  dao.upsertInstall({ installId: 'i1', user: 'u1', host: 'h1',
    nowIso: '2026-07-02T02:00:00.000Z', liveSessions: 0 });
  assert.strictEqual(db.prepare('SELECT live_sessions v FROM installs').get().v, 0); // 0 是有效值要覆盖
});

test('markHbSeen：首次 true、重发 false', (t) => {
  const { dao } = openTempDb(t);
  assert.strictEqual(dao.markHbSeen('e1', '2026-07-02'), true);
  assert.strictEqual(dao.markHbSeen('e1', '2026-07-02'), false);
  assert.strictEqual(dao.markHbSeen('e2', '2026-07-02'), true);
});

test('meta：set/get 往返，覆盖更新', (t) => {
  const { dao } = openTempDb(t);
  assert.strictEqual(dao.metaGet('nope'), null);
  dao.metaSet('last_job_day', '2026-07-01');
  dao.metaSet('last_job_day', '2026-07-02');
  assert.strictEqual(dao.metaGet('last_job_day'), '2026-07-02');
});

test('insertEvent：INSERT OR IGNORE 幂等（changes 0/1）', (t) => {
  const { dao } = openTempDb(t);
  const row = { eventId: 'e1', installId: 'i1', user: 'u', host: 'h', type: 'session_start',
    clientTs: null, serverTs: '2026-07-02T01:00:00.000Z', day: '2026-07-02',
    appVersion: '1.0.0', payload: '{}' };
  assert.strictEqual(dao.insertEvent(row), 1);
  assert.strictEqual(dao.insertEvent(row), 0); // 重发不落第二行
});

'use strict';
// helpers.js —— 测试公共夹具（非 .test.js，不被 runner 当测试执行）。
// 临时库用真实文件而非 ':memory:'：WAL 对内存库无效，走文件才与生产 PRAGMA 路径一致。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { openDb } = require('../lib/db');
const { createApp } = require('../server');

// Windows 下必须先 close 再删目录（打开中的 db 文件持锁），故合并到同一个 t.after
function openTempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const handle = openDb(path.join(dir, 'test.db'));
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return handle;
}

// 起一个监听随机端口的 HTTP server，t.after 自动关
function listenApp(t, app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ server, baseUrl: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

// 完整 app 夹具：临时库 + createApp + 随机端口；t.after 顺序 = server close → db close → 删目录
// 鉴权默认关（authGate:false）——旧特性用例不带凭据直打 /v1，保持免鉴权；
// 鉴权自身用例传 { auth: true } 开启全局门禁（可选 adminUser/adminPassword 定制预置管理员）。
async function makeApp(t, opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const handle = createApp({
    dbPath: path.join(dir, 'test.db'),
    nowFn: opts.nowFn,
    authGate: !!opts.auth,
    adminUser: opts.adminUser,
    adminPassword: opts.adminPassword || 'admin123', // 显式传值走非告警分支，保持测试输出干净
  });
  const { baseUrl } = await listenApp(t, handle.app);
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { baseUrl, db: handle.db, dao: handle.dao };
}

async function postJson(baseUrl, p, body) {
  const res = await fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getJson(baseUrl, p) {
  const res = await fetch(baseUrl + p);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 构造合法 v1 事件信封（测试用最小事实 + 可覆盖）
let _seq = 0;
function makeEvent(over) {
  _seq++;
  return Object.assign({
    schemaVersion: 1,
    eventId: 'ev-' + _seq,
    type: 'session_start',
    ts: '2026-07-02T09:30:00+08:00',
    installId: 'inst-1',
    user: 'zhangsan',
    host: 'HOST-A',
    platform: 'win32',
    appVersion: '1.4.0',
    channel: 'packaged',
    bootId: 'boot-1',
    payload: {},
  }, over);
}

module.exports = { openTempDb, listenApp, makeApp, postJson, getJson, makeEvent };

'use strict';
// auth.test.js —— 登录鉴权：迁移/单管理员约束/口令/seed + 门禁(401/302) + 登录(Cookie/Bearer)
// + 账号管理(role 恒 user / 权限 / 删除 / 校验) + 登出/过期会话失效。
// 门禁默认关（见 helpers），故本文件一律用 makeApp(t, { auth: true }) 开启全局门禁。

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeApp } = require('./helpers');
const { openDb } = require('../lib/db');
const auth = require('../lib/auth');

// 原始 HTTP 请求：不跟随重定向（观测 302 + Location）、可读 set-cookie、返回解析后的 JSON
function req(baseUrl, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + p);
    const headers = Object.assign({}, opts.headers);
    let payload;
    if (opts.body !== undefined) {
      payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* 非 JSON（如 login.html） */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

const login = (baseUrl, username, password) => req(baseUrl, 'POST', '/v1/auth/login', { body: { username, password } });
const bearer = (token) => ({ authorization: 'Bearer ' + token });
function cookieHeader(setCookie) {
  const c = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return { cookie: c.split(';')[0] };
}

// 临时库（dao/迁移级断言，不起 HTTP）
function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-auth-'));
  const h = openDb(path.join(dir, 'test.db'));
  t.after(() => { h.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return h;
}

// ---- 迁移 / 约束 / 口令 / seed（dao 级）----

test('迁移 v2：accounts/sessions 表存在，user_version=2', (t) => {
  const { db } = tempDb(t);
  assert.strictEqual(db.pragma('user_version', { simple: true }), 2);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('accounts'), 'accounts 表应存在');
  assert.ok(tables.includes('sessions'), 'sessions 表应存在');
});

test('单管理员约束：库层拒绝第二个 admin（普通用户不受限）', (t) => {
  const { dao } = tempDb(t);
  dao.insertAccount({ username: 'a1', passHash: 'h', salt: 's', role: 'admin', createdAt: 'x' });
  assert.throws(
    () => dao.insertAccount({ username: 'a2', passHash: 'h', salt: 's', role: 'admin', createdAt: 'x' }),
    /UNIQUE|constraint/i,
  );
  dao.insertAccount({ username: 'u1', passHash: 'h', salt: 's', role: 'user', createdAt: 'x' });
  dao.insertAccount({ username: 'u2', passHash: 'h', salt: 's', role: 'user', createdAt: 'x' });
  assert.strictEqual(dao.countAdmins(), 1);
});

test('口令：hashPassword/verifyPassword 往返、错密码拒绝', () => {
  const { hash, salt } = auth.hashPassword('s3cret!');
  assert.ok(auth.verifyPassword('s3cret!', hash, salt));
  assert.ok(!auth.verifyPassword('wrong', hash, salt));
  assert.ok(!auth.verifyPassword('s3cret!', '', ''));
});

test('seedAdmin：幂等，仅一个 admin', (t) => {
  const { dao } = tempDb(t);
  auth.seedAdmin(dao, { adminUser: 'admin', adminPassword: 'pw123456' });
  auth.seedAdmin(dao, { adminUser: 'admin', adminPassword: 'pw123456' });
  assert.strictEqual(dao.countAdmins(), 1);
  const acct = dao.qAccountByUsername('admin');
  assert.strictEqual(acct.role, 'admin');
  assert.ok(auth.verifyPassword('pw123456', acct.passHash, acct.salt));
});

test('会话过期：resolveAccount 惰性失效并删除', (t) => {
  const { dao } = tempDb(t);
  auth.seedAdmin(dao, { adminUser: 'admin', adminPassword: 'pw123456' });
  dao.insertSession({ token: 'tok', username: 'admin', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z' });
  const acct = auth.resolveAccount(dao, { headers: { authorization: 'Bearer tok' } }, () => new Date('2026-01-01T00:00:00.000Z'));
  assert.strictEqual(acct, null);
  assert.strictEqual(dao.qSession('tok'), null, '过期会话应被惰性删除');
});

// ---- 门禁（HTTP）----

test('门禁：未登录 /v1 → 401；页面 → 302 login.html；login.html/healthz 放行', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });

  const s = await req(baseUrl, 'GET', '/v1/stats/overview');
  assert.strictEqual(s.status, 401);
  assert.strictEqual(s.json.ok, false);

  const page = await req(baseUrl, 'GET', '/');
  assert.strictEqual(page.status, 302);
  assert.strictEqual(page.headers.location, '/login.html');

  assert.strictEqual((await req(baseUrl, 'GET', '/js/main.js')).status, 302); // 静态资源同样门禁
  assert.strictEqual((await req(baseUrl, 'GET', '/login.html')).status, 200);
  assert.strictEqual((await req(baseUrl, 'GET', '/healthz')).status, 200);
});

// ---- 登录 + 双通道会话 ----

test('登录：错误凭据 401、缺字段 400、正确 200 + Set-Cookie + token', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  assert.strictEqual((await login(baseUrl, 'admin', 'wrong')).status, 401);
  assert.strictEqual((await req(baseUrl, 'POST', '/v1/auth/login', { body: {} })).status, 400);

  const ok = await login(baseUrl, 'admin', 'admin123');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.data.username, 'admin');
  assert.strictEqual(ok.json.data.role, 'admin');
  assert.ok(ok.json.data.token, '返回体应带 token 供机器客户端');
  assert.ok(/ops_session=/.test(String(ok.headers['set-cookie'])), '应下发 ops_session Cookie');
});

test('鉴权后访问 stats/events/me：Bearer 与 Cookie 双通道', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const ok = await login(baseUrl, 'admin', 'admin123');
  const token = ok.json.data.token;

  const bs = await req(baseUrl, 'GET', '/v1/stats/overview', { headers: bearer(token) });
  assert.strictEqual(bs.status, 200);
  assert.strictEqual(bs.json.ok, true);

  // 采集端上报（空批）带 Bearer → 200
  const ev = await req(baseUrl, 'POST', '/v1/events', { headers: bearer(token), body: { events: [] } });
  assert.strictEqual(ev.status, 200);
  assert.strictEqual(ev.json.ok, true);

  const cs = await req(baseUrl, 'GET', '/v1/stats/overview', { headers: cookieHeader(ok.headers['set-cookie']) });
  assert.strictEqual(cs.status, 200);

  const me = await req(baseUrl, 'GET', '/v1/auth/me', { headers: bearer(token) });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.data.username, 'admin');
  assert.strictEqual(me.json.data.role, 'admin');
});

// ---- 账号管理 ----

test('账号管理：新增普通用户（role 恒 user）+ 校验 + 权限 + 删除', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const H = bearer((await login(baseUrl, 'admin', 'admin123')).json.data.token);

  const c = await req(baseUrl, 'POST', '/v1/auth/users', { headers: H, body: { username: 'alice', password: 'pw123456' } });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.json.data.role, 'user', '新增账号角色恒为 user');

  assert.strictEqual((await req(baseUrl, 'POST', '/v1/auth/users', { headers: H, body: { username: 'alice', password: 'pw123456' } })).status, 409, '重名 409');
  assert.strictEqual((await req(baseUrl, 'POST', '/v1/auth/users', { headers: H, body: { username: 'bob', password: '123' } })).status, 400, '短密码 400');
  assert.strictEqual((await req(baseUrl, 'POST', '/v1/auth/users', { headers: H, body: { username: 'bad name!', password: 'pw123456' } })).status, 400, '非法用户名 400');

  // alice 登录：角色 user、无管理员权限
  const aliceTok = (await login(baseUrl, 'alice', 'pw123456')).json.data.token;
  assert.strictEqual((await req(baseUrl, 'GET', '/v1/auth/me', { headers: bearer(aliceTok) })).json.data.role, 'user');
  assert.strictEqual((await req(baseUrl, 'GET', '/v1/auth/users', { headers: bearer(aliceTok) })).status, 403, '普通用户列账号 403');
  assert.strictEqual((await req(baseUrl, 'POST', '/v1/auth/users', { headers: bearer(aliceTok), body: { username: 'x', password: 'pw123456' } })).status, 403, '普通用户建账号 403');

  const list = await req(baseUrl, 'GET', '/v1/auth/users', { headers: H });
  const names = list.json.data.users.map((u) => u.username);
  assert.ok(names.includes('admin') && names.includes('alice'));

  // 删 admin 被拒；删 alice 成功且其会话失效
  assert.strictEqual((await req(baseUrl, 'DELETE', '/v1/auth/users/admin', { headers: H })).status, 400, '拒绝删除 admin');
  assert.strictEqual((await req(baseUrl, 'DELETE', '/v1/auth/users/alice', { headers: H })).status, 200);
  assert.strictEqual((await req(baseUrl, 'GET', '/v1/auth/me', { headers: bearer(aliceTok) })).status, 401, '删除用户后其会话失效');
});

test('登出：会话失效', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const token = (await login(baseUrl, 'admin', 'admin123')).json.data.token;
  assert.strictEqual((await req(baseUrl, 'GET', '/v1/auth/me', { headers: bearer(token) })).status, 200);
  await req(baseUrl, 'POST', '/v1/auth/logout', { headers: bearer(token) });
  assert.strictEqual((await req(baseUrl, 'GET', '/v1/auth/me', { headers: bearer(token) })).status, 401);
});

test('改密：旧密码错 401、成功后新密码可登录', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const H = bearer((await login(baseUrl, 'admin', 'admin123')).json.data.token);
  assert.strictEqual((await req(baseUrl, 'POST', '/v1/auth/password', { headers: H, body: { oldPassword: 'nope', newPassword: 'newpw123' } })).status, 401);
  assert.strictEqual((await req(baseUrl, 'POST', '/v1/auth/password', { headers: H, body: { oldPassword: 'admin123', newPassword: 'newpw123' } })).status, 200);
  assert.strictEqual((await login(baseUrl, 'admin', 'admin123')).status, 401, '旧密码失效');
  assert.strictEqual((await login(baseUrl, 'admin', 'newpw123')).status, 200, '新密码可登录');
});

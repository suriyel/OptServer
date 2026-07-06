'use strict';
// auth.js —— 简单登录鉴权：口令(scrypt) + 会话令牌 + 全局门禁 + 账号路由。
//
// 设计要点：
// · 零新增依赖——口令哈希用内置 crypto.scryptSync + timingSafeEqual，令牌用 randomBytes，
//   写 Cookie 用 Express 内置 res.cookie，读 Cookie 手工解析 req.headers.cookie。
// · 采集端上报 POST /v1/events 开放（内网即信任，cancong 客户端不带任何凭据）；其余
//   页面与 /v1 接口需登录：浏览器带 ops_session Cookie，脚本可选用 Authorization: Bearer。
// · 单一管理员：新建用户恒 role='user'（应用层）；库层 ux_accounts_admin partial unique
//   index 兜底，任何路径都造不出第二个 admin（见 lib/db.js DDL_V2）。
// · 门禁是「全局」中间件（含 static）。白名单：/healthz、/login.html、登录接口、POST /v1/events；
//   其余未登录访问页面→302 login.html、访问 /v1→401 JSON。

const crypto = require('crypto');
const express = require('express');

const COOKIE_NAME = 'ops_session';
const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MIN_PASSWORD_LEN = 6;

function nonEmptyStr(v) { return typeof v === 'string' && v.length > 0; }
function sessionDays() { return Number(process.env.OPS_SESSION_DAYS) || 7; }

// ---- 口令 & 令牌 ----

// scrypt 派生 64 字节；salt 随机每账号独立。返回 hex 串，落 accounts.pass_hash/salt。
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

// 定长比较用 timingSafeEqual 防时序侧信道；长度不等直接 false（timingSafeEqual 长度不等会抛）。
function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
}

function genToken() { return crypto.randomBytes(32).toString('hex'); }

// 手工解析单个 Cookie（不引入 cookie-parser）
function parseCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// 令牌来源：优先 Authorization: Bearer（机器客户端），否则 ops_session Cookie（浏览器）
function tokenFromReq(req) {
  const auth = req.headers && req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return parseCookie(req.headers && req.headers.cookie, COOKIE_NAME);
}

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
    secure: process.env.OPS_SECURE_COOKIE === '1', // 内网 HTTP 默认关；HTTPS 部署设为 1
  };
}

// 令牌 → 账号。会话缺失/过期/账号已删 → null（过期与孤儿会话惰性清理）。
// 回读 accounts 取「当前」role（账号被删或角色变更即时生效）。
function resolveAccount(dao, req, nowFn) {
  const token = tokenFromReq(req);
  if (!token) return null;
  const s = dao.qSession(token);
  if (!s) return null;
  const nowIso = (nowFn ? nowFn() : new Date()).toISOString();
  if (s.expiresAt && s.expiresAt < nowIso) { dao.deleteSession(token); return null; }
  const acct = dao.qAccountByUsername(s.username);
  if (!acct) { dao.deleteSession(token); return null; }
  return { username: acct.username, role: acct.role, token };
}

// ---- 预置管理员（幂等）----
// 仅当库中无 admin 时预置。凭据优先级：opts > 环境变量 > 默认值。用默认密码时打印告警。
function seedAdmin(dao, opts) {
  opts = opts || {};
  if (dao.countAdmins() > 0) return;
  const username = opts.adminUser || process.env.OPS_ADMIN_USER || DEFAULT_ADMIN_USER;
  const explicitPw = opts.adminPassword || process.env.OPS_ADMIN_PASSWORD;
  const password = explicitPw || DEFAULT_ADMIN_PASSWORD;
  const { hash, salt } = hashPassword(password);
  const nowIso = (opts.nowFn ? opts.nowFn() : new Date()).toISOString();
  dao.insertAccount({ username, passHash: hash, salt, role: 'admin', createdAt: nowIso });
  if (explicitPw) {
    console.log('[auth] 已预置管理员 "' + username + '"');
  } else {
    console.log('[auth] 已预置管理员 "' + username + '"，使用默认密码 "' + DEFAULT_ADMIN_PASSWORD
      + '"，请尽快通过「账号管理」修改，或用 OPS_ADMIN_PASSWORD 指定初始密码');
  }
}

// ---- 全局门禁中间件 ----
// 白名单：探活、登录页、登录接口、采集端上报（POST /v1/events 内网即信任，客户端免鉴权）。
// 其余：命中会话放行并挂 req.account；未登录时 /v1 请求→401 JSON，页面请求→302 至 login.html。
function createAuthGate(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  return function authGate(req, res, next) {
    const p = req.path;
    if (p === '/healthz' || p === '/login.html' || p === '/v1/auth/login') return next();
    if (req.method === 'POST' && p === '/v1/events') return next(); // 采集端上报开放
    const account = resolveAccount(dao, req, nowFn);
    if (account) { req.account = account; return next(); }
    if (p.startsWith('/v1')) return res.status(401).json({ ok: false, error: 'unauthorized' });
    return res.redirect(302, '/login.html');
  };
}

function requireAdmin(req, res, next) {
  if (!req.account || req.account.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

// ---- 认证/账号路由（挂在 /v1 下）----
function createAuthRouter(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const router = express.Router();

  // 登录：白名单开放（门禁放行）。校验口令→建会话→下发 Cookie；返回体带 token 供机器客户端。
  router.post('/auth/login', (req, res) => {
    const body = req.body || {};
    if (!nonEmptyStr(body.username) || !nonEmptyStr(body.password)) {
      return res.status(400).json({ ok: false, error: 'missing credentials' });
    }
    const acct = dao.qAccountByUsername(String(body.username));
    if (!acct || !verifyPassword(body.password, acct.passHash, acct.salt)) {
      return res.status(401).json({ ok: false, error: 'invalid credentials' });
    }
    const token = genToken();
    const now = nowFn();
    const maxAgeMs = sessionDays() * 86400000;
    const expiresAt = new Date(now.getTime() + maxAgeMs).toISOString();
    dao.insertSession({ token, username: acct.username, createdAt: now.toISOString(), expiresAt });
    res.cookie(COOKIE_NAME, token, cookieOptions(maxAgeMs));
    res.json({ ok: true, data: { username: acct.username, role: acct.role, token } });
  });

  // 登出：删会话 + 清 Cookie（无会话也返回 ok，幂等）
  router.post('/auth/logout', (req, res) => {
    const token = tokenFromReq(req);
    if (token) dao.deleteSession(token);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  // 当前登录者（门禁已保证 req.account 存在）
  router.get('/auth/me', (req, res) => {
    if (!req.account) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({ ok: true, data: { username: req.account.username, role: req.account.role } });
  });

  // 改本人口令（校验旧口令）
  router.post('/auth/password', (req, res) => {
    if (!req.account) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const body = req.body || {};
    if (!nonEmptyStr(body.newPassword) || String(body.newPassword).length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ ok: false, error: 'password too short' });
    }
    const acct = dao.qAccountByUsername(req.account.username);
    if (!acct || !verifyPassword(body.oldPassword, acct.passHash, acct.salt)) {
      return res.status(401).json({ ok: false, error: 'invalid credentials' });
    }
    const { hash, salt } = hashPassword(String(body.newPassword));
    dao.updateAccountPassword(acct.username, hash, salt);
    res.json({ ok: true });
  });

  // 列出账号（管理员）
  router.get('/auth/users', requireAdmin, (req, res) => {
    res.json({ ok: true, data: { users: dao.listAccounts() } });
  });

  // 新增普通用户（管理员）。role 强制 'user'——永不新增第二个 admin。
  router.post('/auth/users', requireAdmin, (req, res) => {
    const body = req.body || {};
    const uname = nonEmptyStr(body.username) ? String(body.username).trim() : '';
    if (!uname || !USERNAME_RE.test(uname)) {
      return res.status(400).json({ ok: false, error: 'invalid username' });
    }
    if (!nonEmptyStr(body.password) || String(body.password).length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ ok: false, error: 'password too short' });
    }
    if (dao.qAccountByUsername(uname)) {
      return res.status(409).json({ ok: false, error: 'username exists' });
    }
    const { hash, salt } = hashPassword(String(body.password));
    dao.insertAccount({ username: uname, passHash: hash, salt, role: 'user', createdAt: nowFn().toISOString() });
    res.json({ ok: true, data: { username: uname, role: 'user' } });
  });

  // 删除用户（管理员）。拒绝删除 admin；连带清其会话。
  router.delete('/auth/users/:username', requireAdmin, (req, res) => {
    const uname = String(req.params.username);
    const acct = dao.qAccountByUsername(uname);
    if (!acct) return res.status(404).json({ ok: false, error: 'not found' });
    if (acct.role === 'admin') return res.status(400).json({ ok: false, error: 'cannot delete admin' });
    dao.deleteAccountByUsername(uname);
    dao.deleteSessionsByUser(uname);
    res.json({ ok: true });
  });

  return router;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  genToken,
  parseCookie,
  resolveAccount,
  seedAdmin,
  createAuthGate,
  createAuthRouter,
};

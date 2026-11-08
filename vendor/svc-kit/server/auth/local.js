'use strict';
// kit/server/auth/local.js —— local 鉴权提供者：口令(scrypt) + 会话令牌 + 账号路由。
// 源自 OptServer lib/auth.js（2026-11-08 抽进 kit，两服务共用；OptServer 经 kit:sync 拿副本）。
//
// · 零新增依赖——口令哈希用内置 crypto.scryptSync + timingSafeEqual，令牌用 randomBytes，
//   写 Cookie 用 Express 内置 res.cookie，读 Cookie 手工解析 req.headers.cookie。
// · **不拥有表**：accounts / sessions 的 DDL 归宿主应用自己的迁移序列（kit 不碰任何一方的 user_version）；
//   宿主经 dao 注入 qAccountByUsername / insertAccount / listAccounts / deleteAccountByUsername /
//   updateAccountPassword / countAdmins / insertSession / qSession / deleteSession / deleteSessionsByUser。
// · 命名参数化：cookieName（EvolveServer evo_session / OptServer ops_session）、envPrefix（EVOLVE_ / OPS_）
//   ⇒ 两服务同机不互相覆盖 Cookie，且与各自现网 Cookie / env 一字不差。
// · 单一管理员：新建用户恒 role='user'（应用层）；宿主库层 ux_accounts_admin partial unique index 兜底。

const crypto = require('crypto');
const express = require('express');
const { requireAdmin } = require('./require');

const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MIN_PASSWORD_LEN = 6;

function nonEmptyStr(v) { return typeof v === 'string' && v.length > 0; }

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

// 令牌来源：优先 Authorization: Bearer（机器客户端），否则 Cookie（浏览器）。via 供 CSRF 头校验分流。
function tokenFromReq(req, cookieName) {
  const auth = req.headers && req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return { token: auth.replace(/^Bearer\s+/i, '').trim(), via: 'bearer' };
  const c = parseCookie(req.headers && req.headers.cookie, cookieName);
  return c ? { token: c, via: 'cookie' } : null;
}

function cookieOptions(maxAgeMs, envPrefix) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
    secure: process.env[envPrefix + 'SECURE_COOKIE'] === '1', // 内网 HTTP 默认关；HTTPS 部署设为 1
  };
}

// 令牌 → 账号。会话缺失/过期/账号已删 → null（过期与孤儿会话惰性清理）。
// 回读 accounts 取「当前」role（账号被删或角色变更即时生效）。
function resolveAccount(dao, req, nowFn, cookieName) {
  const t = tokenFromReq(req, cookieName);
  if (!t) return null;
  const s = dao.qSession(t.token);
  if (!s) return null;
  const nowIso = (nowFn ? nowFn() : new Date()).toISOString();
  if (s.expiresAt && s.expiresAt < nowIso) { dao.deleteSession(t.token); return null; }
  const acct = dao.qAccountByUsername(s.username);
  if (!acct) { dao.deleteSession(t.token); return null; }
  return { username: acct.username, role: acct.role, token: t.token, via: t.via };
}

// 预置管理员（幂等）：仅当库中无 admin 时预置。凭据优先级：opts > 环境变量 > 默认值。用默认密码时打印告警。
function seedAdmin(dao, opts) {
  opts = opts || {};
  if (dao.countAdmins() > 0) return;
  const p = opts.envPrefix || '';
  const username = opts.adminUser || process.env[p + 'ADMIN_USER'] || DEFAULT_ADMIN_USER;
  const explicitPw = opts.adminPassword || process.env[p + 'ADMIN_PASSWORD'];
  const password = explicitPw || DEFAULT_ADMIN_PASSWORD;
  const { hash, salt } = hashPassword(password);
  const nowIso = (opts.nowFn ? opts.nowFn() : new Date()).toISOString();
  dao.insertAccount({ username, passHash: hash, salt, role: 'admin', createdAt: nowIso });
  if (explicitPw) {
    console.log('[auth] 已预置管理员 "' + username + '"');
  } else {
    console.log('[auth] 已预置管理员 "' + username + '"，使用默认密码 "' + DEFAULT_ADMIN_PASSWORD
      + '"，请尽快通过「账号管理」修改，或用 ' + p + 'ADMIN_PASSWORD 指定初始密码');
  }
}

// 认证/账号路由（挂在 /v1 下）
function createLocalAuthRouter(dao, o) {
  const nowFn = o.nowFn;
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
    const maxAgeMs = o.sessionDays() * 86400000;
    const expiresAt = new Date(now.getTime() + maxAgeMs).toISOString();
    dao.insertSession({ token, username: acct.username, createdAt: now.toISOString(), expiresAt });
    res.cookie(o.cookieName, token, cookieOptions(maxAgeMs, o.envPrefix));
    res.json({ ok: true, data: { username: acct.username, role: acct.role, token } });
  });

  // 登出：删会话 + 清 Cookie（无会话也返回 ok，幂等）
  router.post('/auth/logout', (req, res) => {
    const t = tokenFromReq(req, o.cookieName);
    if (t) dao.deleteSession(t.token);
    res.clearCookie(o.cookieName, { path: '/' });
    res.json({ ok: true });
  });

  // 当前登录者（门禁已保证 req.account 存在）
  router.get('/auth/me', (req, res) => {
    if (!req.account) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({ ok: true, data: Object.assign({ username: req.account.username, role: req.account.role }, o.meExtra || {}) });
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

/**
 * local 提供者（SPI 见 kit/server/auth/gate.js 文件头）。
 * @param {{ dao: any, cookieName: string, envPrefix: string, nowFn?: () => Date, loginPath?: string }} opts
 */
function createLocalProvider(opts) {
  const o = {
    dao: opts.dao,
    cookieName: opts.cookieName,
    envPrefix: opts.envPrefix || '',
    nowFn: opts.nowFn || (() => new Date()),
    loginPath: opts.loginPath || '/login.html',
    meExtra: { provider: 'local' },
  };
  o.sessionDays = () => Number(process.env[o.envPrefix + 'SESSION_DAYS']) || 7;
  return {
    name: 'local',
    features: { accounts: true, password: true },
    resolve(req) { return resolveAccount(o.dao, req, o.nowFn, o.cookieName); },
    loginUrl() { return o.loginPath; },
    isPublic(req) { return req.path === o.loginPath || (req.method === 'POST' && req.path === '/v1/auth/login'); },
    router: createLocalAuthRouter(o.dao, o),
    seedAdmin(seedOpts) { seedAdmin(o.dao, Object.assign({ envPrefix: o.envPrefix, nowFn: o.nowFn }, seedOpts || {})); },
  };
}

module.exports = {
  hashPassword, verifyPassword, genToken, parseCookie, tokenFromReq, cookieOptions,
  resolveAccount, seedAdmin, createLocalAuthRouter, createLocalProvider,
  DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASSWORD,
};

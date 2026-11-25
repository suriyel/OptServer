'use strict';
// auth.js —— 登录鉴权（薄包装）：口令 / 会话 / 账号路由用 kit 的 local 提供者（vendor/svc-kit，真源 EvolveServer/kit），
// 本文件只保留 cancong-ops 自己的门禁白名单与对外导出名（server.js / update.js / 测试都按这些名字用）。
// TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §0 Q8 / §9。
//
// · 采集端上报 POST /v1/events 开放（内网即信任，cancong 客户端不带任何凭据）；其余页面与 /v1 接口需登录：
//   浏览器带 ops_session Cookie，脚本可选用 Authorization: Bearer。
// · Cookie 名 ops_session、env 前缀 OPS_ 与拆分前一字不差 ⇒ 已登录用户升级后不掉线。
// · 单一管理员：新建用户恒 role='user'（应用层）；库层 ux_accounts_admin partial unique index 兜底（lib/db.js DDL_V2）。
// · 门禁是「全局」中间件（含 static）。白名单见 isPublic；其余未登录访问页面→302 login.html、访问 /v1→401 JSON。
// · cancong-evolve 共部署时用 ops 提供者内省本服务 GET /v1/auth/me（返回 {ok, data:{username, role, provider}}）。

const kitLocal = require('../vendor/svc-kit/server/auth/local');
const { createGate } = require('../vendor/svc-kit/server/auth/gate');
const { requireAdmin } = require('../vendor/svc-kit/server/auth/require');

const COOKIE_NAME = 'ops_session';
const ENV_PREFIX = 'OPS_';

function provider(dao, nowFn) {
  return kitLocal.createLocalProvider({ dao, cookieName: COOKIE_NAME, envPrefix: ENV_PREFIX, nowFn });
}

// 令牌 → 账号（会话缺失 / 过期 / 账号已删 → null，惰性清理）
function resolveAccount(dao, req, nowFn) {
  return kitLocal.resolveAccount(dao, req, nowFn, COOKIE_NAME);
}

// 预置管理员（幂等）：仅当库中无 admin 时预置。凭据优先级：opts > OPS_ADMIN_USER/PASSWORD > 默认值（用默认密码时告警）
function seedAdmin(dao, opts) {
  kitLocal.seedAdmin(dao, Object.assign({ envPrefix: ENV_PREFIX }, opts || {}));
}

// 白名单：探活、登录页、登录接口、采集端上报、更新查版 / 下载、服务发现（客户端没有账号，内网即信任）
function isPublic(req) {
  const p = req.path;
  if (p === '/healthz' || p === '/login.html' || p === '/v1/auth/login') return true;
  if (req.method === 'POST' && p === '/v1/events') return true;            // 采集端上报开放
  // 应用自动更新查版/下载开放（上传/发布仍在门禁内且 requireAdmin——见 lib/update.js）
  if (req.method === 'GET' && (p === '/v1/update/latest' || p.startsWith('/v1/update/download/'))) return true;
  // 服务发现（客户端据此找自进化服务；看板也用它决定是否挂「自进化」页签）——lib/discovery.js
  if (req.method === 'GET' && p === '/v1/discovery') return true;
  // cancong-evolve 拉人员（需求研发看板）：服务进程没有会话，路由内只认回环 / OPS_EVOLVE 主机——lib/internal.js
  if (req.method === 'GET' && p === '/v1/internal/persons') return true;
  return false;
}

function createAuthGate(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  return createGate({ provider: provider(dao, nowFn), isPublic });
}

function createAuthRouter(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  return provider(dao, nowFn).router;
}

module.exports = {
  COOKIE_NAME,
  hashPassword: kitLocal.hashPassword,
  verifyPassword: kitLocal.verifyPassword,
  genToken: kitLocal.genToken,
  parseCookie: kitLocal.parseCookie,
  resolveAccount,
  seedAdmin,
  createAuthGate,
  createAuthRouter,
  requireAdmin,
  isPublic,
};

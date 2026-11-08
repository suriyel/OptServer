'use strict';
// kit/server/auth/require.js —— 路由级守卫。门禁（gate.js）已挂 req.account / req.authVia。

// 管理员写口
function requireAdmin(req, res, next) {
  if (!req.account || req.account.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

// CSRF 头：**只约束 Cookie 鉴权的写请求**（设计稿 §5.3 / §10）。自定义头让浏览器必须先发预检，
// 不在 CORS 白名单里的 origin（含同主机其它端口的服务）被浏览器拦下。Bearer 脚本 / 未登录接口豁免。
const CSRF_HEADER = 'x-evo-client';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
function requireCsrfHeader(req, res, next) {
  if (SAFE.has(req.method) || req.authVia !== 'cookie') return next();
  if (req.headers[CSRF_HEADER] === '1') return next();
  return res.status(403).json({ ok: false, error: 'missing X-Evo-Client header' });
}

module.exports = { requireAdmin, requireCsrfHeader, CSRF_HEADER };

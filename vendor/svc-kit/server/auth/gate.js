'use strict';
// kit/server/auth/gate.js —— 全局门禁：白名单 → provider.resolve → 挂 req.account / 401 / 302 / 503。
//
// 鉴权提供者 SPI（设计稿 §5.3）：
//   { name, features:{accounts, password},
//     resolve(req) → Account | null | Promise<…>   // null = 未登录；throw AuthUnavailable = 上游不可达
//     loginUrl(req) → string                        // 未登录页面重定向目标
//     isPublic?(req) → boolean                      // 提供者自己的免登录路径（登录页 / 登录接口）
//     router?: express.Router }                     // 提供者自带 /auth/* 路由
//   Account = { username, role:'admin'|'user', via?:'cookie'|'bearer', ... }
// 门禁与路由层只认 req.account —— 换提供者（local / 工号登录 / 未来 SSO）业务代码零改。

class AuthUnavailable extends Error {
  constructor(msg) { super(msg || 'auth upstream unavailable'); this.code = 'auth_unavailable'; }
}

/**
 * @param {{ provider: any, isPublic?: (req: any) => boolean, apiPrefix?: string }} opts
 */
function createGate(opts) {
  const provider = opts.provider;
  const isPublic = opts.isPublic || (() => false);
  const api = opts.apiPrefix || '/v1';
  return async function gate(req, res, next) {
    if (req.path === '/healthz' || isPublic(req) || (provider.isPublic && provider.isPublic(req))) return next();
    let account;
    try {
      account = await provider.resolve(req);
    } catch (e) {
      if (e && e.code === 'auth_unavailable') {
        // fail-closed：不是 401（避免登录页回跳死循环），也绝不降级为匿名
        if (req.path.startsWith(api)) return res.status(503).json({ ok: false, error: 'auth upstream unavailable' });
        return res.status(503).type('text/plain; charset=utf-8').send('鉴权上游不可达，请稍后重试');
      }
      return next(e);
    }
    if (account) { req.account = account; req.authVia = account.via || null; return next(); }
    if (req.path.startsWith(api)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    return res.redirect(302, provider.loginUrl(req));
  };
}

module.exports = { createGate, AuthUnavailable };

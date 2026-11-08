'use strict';
// kit/server/cors.js —— 带凭据 CORS（设计稿 §4.4 / §5.3 / §10）。**排在门禁之前**：
// 预检 OPTIONS 不带 Cookie，进门禁必 401 ⇒ 在这里直接 204 结束。
//
// 白名单条目：
//   · 绝对 origin（'http://10.169.74.11:5900'）——精确比较；
//   · ':<port>' 同主机相对——Origin 主机名与本请求 Host 主机名相同、且端口为该值即命中
//     （中心两地两 IP 各回各的；DNS rebinding 下无凭据，见设计稿 §10）。
// 绝不支持 '*'；只回显命中的那个 origin，并带 Vary: Origin。

const ALLOW_HEADERS = 'Content-Type, Authorization, X-Evo-Client';
const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

function parseOrigins(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
}

function hostOf(req) {
  const h = String((req.headers && req.headers.host) || '');
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

function matches(entry, origin, req) {
  let u;
  try { u = new URL(origin); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (entry.startsWith(':')) {
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return port === entry.slice(1) && u.hostname === hostOf(req);
  }
  return u.origin === entry.replace(/\/+$/, '');
}

/** @param {{ origins: string | string[] }} opts */
function createCors(opts) {
  const list = Array.isArray(opts.origins) ? opts.origins.filter((s) => s && s !== '*') : parseOrigins(opts.origins);
  return function cors(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) return next();
    res.append('Vary', 'Origin');
    const ok = list.some((e) => matches(e, origin, req));
    if (ok) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      if (ok) {
        res.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
        res.set('Access-Control-Allow-Methods', ALLOW_METHODS);
        res.set('Access-Control-Max-Age', '600');
      }
      return res.status(204).end(); // 未命中：不带 CORS 头的 204，浏览器自会拦下真实请求
    }
    next();
  };
}

module.exports = { createCors, parseOrigins, matches };

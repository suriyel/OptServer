'use strict';
// kit/server/auth/ops.js —— ops 鉴权提供者：共部署时内省 cancong-ops 的会话（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §4.3）。
//
// · 本服务不存账号：取请求的 Bearer ▷ ops_session Cookie（同主机不同端口，浏览器自动携带），原样转发给
//   GET <opsUrl>/v1/auth/me（cancong-ops 回 {ok, data:{username, role}}）。角色直接映射（admin = 管理员，user = 只读）。
// · 缓存：sha256(令牌) → 账号，TTL 30s、LRU 上限 1000；否定结果不缓存（刚登录的人不用等 30 秒）。
//   ⇒ 已知接受：登出后至多 30 秒内令牌仍被放行（内网、个位数用户）。
// · 内省地址只来自配置（opsUrl），与请求无关 ⇒ 无 SSRF 面；只转发 Cookie / Authorization 两个头。
// · fail-closed：网络错 / 超时 / 5xx ⇒ 抛 AuthUnavailable（门禁回 503），绝不降级为匿名。
// · 未登录跳 cancong-ops 登录页并带 next 回跳；登录页根 = publicUrl（显式配置）▷ 请求 Host 主机名 + opsUrl 端口
//   （中心两地两 IP，各回各的）。cancong-ops 的 login.html 只认同主机名的 next（防开放重定向）。

const crypto = require('crypto');
const express = require('express');
const { AuthUnavailable } = require('./gate');
const { parseCookie } = require('./local');

const OPS_COOKIE = 'ops_session';

function hostOf(req) {
  const h = String((req.headers && req.headers.host) || '');
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/**
 * @param {{ opsUrl: string, publicUrl?: string, ttlMs?: number, maxEntries?: number, timeoutMs?: number,
 *           fetchImpl?: typeof fetch, nowFn?: () => Date }} opts
 */
function createOpsProvider(opts) {
  const opsUrl = String(opts.opsUrl || '').replace(/\/+$/, '');
  if (!opsUrl) throw new Error('ops provider needs opsUrl');
  const ops = new URL(opsUrl);
  const publicUrl = opts.publicUrl ? String(opts.publicUrl).replace(/\/+$/, '') : '';
  const ttlMs = opts.ttlMs == null ? 30000 : opts.ttlMs;
  const maxEntries = opts.maxEntries || 1000;
  const timeoutMs = opts.timeoutMs || 2000;
  const doFetch = opts.fetchImpl || fetch;
  const now = () => (opts.nowFn ? opts.nowFn() : new Date()).getTime();
  /** @type {Map<string, { account: any, exp: number }>} 插入序即 LRU 序 */
  const cache = new Map();
  let lastErr = '';

  function credsOf(req) {
    const auth = req.headers && req.headers.authorization;
    if (auth && /^Bearer\s+/i.test(auth)) return { token: auth.replace(/^Bearer\s+/i, '').trim(), via: 'bearer', headers: { authorization: auth } };
    const c = parseCookie(req.headers && req.headers.cookie, OPS_COOKIE);
    return c ? { token: c, via: 'cookie', headers: { cookie: OPS_COOKIE + '=' + encodeURIComponent(c) } } : null;
  }

  async function resolve(req) {
    const cr = credsOf(req);
    if (!cr) return null;
    const key = crypto.createHash('sha256').update(cr.token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.exp > now()) { cache.delete(key); cache.set(key, hit); return Object.assign({}, hit.account, { via: cr.via }); }
    if (hit) cache.delete(key);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(opsUrl + '/v1/auth/me', { headers: cr.headers, signal: ctl.signal });
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
      if (msg !== lastErr) console.log('[evolve-auth] 内省 cancong-ops 失败（' + opsUrl + '）：' + msg);
      lastErr = msg;
      throw new AuthUnavailable();
    } finally { clearTimeout(timer); }
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) {
      const msg = 'HTTP ' + res.status;
      if (msg !== lastErr) console.log('[evolve-auth] 内省 cancong-ops 失败（' + opsUrl + '）：' + msg);
      lastErr = msg;
      throw new AuthUnavailable();
    }
    const body = await res.json().catch(() => null);
    const d = body && body.ok === true ? body.data : null;
    if (!d || typeof d.username !== 'string') throw new AuthUnavailable('bad introspection response');
    if (lastErr) { console.log('[evolve-auth] 内省 cancong-ops 已恢复'); lastErr = ''; }
    const account = { username: d.username, role: d.role === 'admin' ? 'admin' : 'user', provider: 'ops' };
    cache.set(key, { account, exp: now() + ttlMs });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return Object.assign({}, account, { via: cr.via });
  }

  function loginUrl(req) {
    const port = ops.port ? ':' + ops.port : '';
    const root = publicUrl || (ops.protocol + '//' + hostOf(req) + port);
    const back = (req.protocol || 'http') + '://' + (req.headers.host || '') + (req.originalUrl || '/');
    return root + '/login.html?next=' + encodeURIComponent(back);
  }

  // /auth/me 在 ops 模式也由本服务应答（外壳只问自己的服务）；账号管理 / 改口令 / 登出归 cancong-ops
  const router = express.Router();
  router.get('/auth/me', (req, res) => {
    if (!req.account) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({ ok: true, data: { username: req.account.username, role: req.account.role, provider: 'ops' } });
  });

  return {
    name: 'ops',
    features: { accounts: false, password: false },
    resolve, loginUrl, router,
    _cacheSize: () => cache.size,
  };
}

module.exports = { createOpsProvider, OPS_COOKIE };

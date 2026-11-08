// @ts-check
// api.js —— /v1 查询封装：非 2xx / ok:false 一律抛 Error，由页面统一渲染错误框。
// kit 共用（EvolveServer 真源，cancong-ops 经 kit:sync 拿副本）：缺省同源 + 401 回 /login.html，
// 与 cancong-ops 原 core/api.js 行为一致；被跨源挂载时（cancong-ops 看板的「自进化」页签）由 mount()
// 调 configure({ apiBase, onUnauthorized }) 指向自进化服务，并带凭据（Cookie 同主机跨端口共享）。

/** @type {{ apiBase: string, onUnauthorized: () => void }} */
const cfg = {
  apiBase: '',
  onUnauthorized: () => { location.href = '/login.html'; },
};

/**
 * @param {{ apiBase?: string, onUnauthorized?: () => void }} o
 */
export function configure(o) {
  if (o.apiBase != null) cfg.apiBase = String(o.apiBase).replace(/\/+$/, '');
  if (o.onUnauthorized) cfg.onUnauthorized = o.onUnauthorized;
}

/** 完整 URL（下载链接等不走 getStats 的场合用） @param {string} p 以 / 开头的 /v1 下路径 */
export function apiUrl(p) { return cfg.apiBase + '/v1' + p; }

/** @param {RequestInit} opts */
function withCreds(opts) {
  if (cfg.apiBase) opts.credentials = 'include';
  return opts;
}

/**
 * @param {string} p 以 / 开头的 /v1 下路径，如 '/stats/overview'
 * @param {Record<string, string>} [params]
 * @returns {Promise<any>} 响应的 data 字段
 */
export async function getStats(p, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(apiUrl(p) + qs, withCreds({}));
  if (res.status === 401) { cfg.onUnauthorized(); throw new Error('unauthorized'); } // 会话过期→回登录
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  if (!body || body.ok !== true) throw new Error((body && body.error) || 'api error');
  return body.data;
}

/**
 * 代际守卫：并发的多次 refresh 只认**最后发起**的那次，丢弃先发后至的旧快照。
 *
 * 没有它就会出现「顶栏显示 7 天、表格渲染 90 天数据」——切档位时旧请求还在途，
 * 90 天查询比 7 天慢，落地顺序与发起顺序相反，后落地的旧结果把新结果覆盖掉。
 * 触发面比想象中大：60s 轮询与 `visibilitychange` 会和手动切档并发。
 *
 * 用法：`const g = guard.next()` → await → `if (guard.stale(g)) return;` **再**改模块状态。
 * 守卫必须挡在**赋值之前**，挡在渲染前是不够的——状态一旦被旧数据写脏，
 * 下一次纯本地重渲染（排序、展开）就会把脏数据画出来。
 */
export function makeGuard() {
  let gen = 0;
  return {
    next() { return ++gen; },
    stale(g) { return g !== gen; },
  };
}

/**
 * 写请求：非 2xx / ok:false 一律抛 Error（带服务端 error 原文）。
 * 带 X-Evo-Client: 1 —— 自进化服务对 Cookie 鉴权的写请求要求此头（强制预检防 CSRF）；cancong-ops 忽略它。
 * @param {string} method
 * @param {string} p 以 / 开头的 /v1 下路径
 * @param {any} [body]
 * @returns {Promise<any>} 响应的 data 字段
 */
export async function send(method, p, body) {
  /** @type {Record<string, string>} */
  const headers = { 'X-Evo-Client': '1' };
  /** @type {RequestInit} */
  const opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(p), withCreds(opts));
  if (res.status === 401) { cfg.onUnauthorized(); throw new Error('unauthorized'); }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true) throw new Error((j && j.error) || ('HTTP ' + res.status));
  return j.data;
}

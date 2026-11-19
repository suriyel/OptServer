// @ts-check
// evolve.js —— 「自进化」页签：只给一个打开自进化网站的链接。
// 自进化中心是独立服务 cancong-evolve，登录自己管（自带账号或工号登录），不认本看板的登录——所以不再把它的页面嵌进来
// （原先跨源挂载靠的是它借用本服务的登录，那种方式 2026-11-19 去掉）。地址来自 /v1/discovery → services.evolve：
//   · { port } ⇒ 同协议 + location.hostname + port（中心两地两 IP 各回各的）
//   · { url }  ⇒ 另一台机器上的绝对地址
//   · null     ⇒ 本中心没有自进化服务：main.js 隐藏页签

/** @type {Promise<any> | null} */ let discoveryP = null;

function discovery() {
  if (!discoveryP) discoveryP = fetch('/v1/discovery').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return discoveryP;
}

/** 自进化网站的根地址；没有就 null（reqflow.js 也用） */
export async function evolveOrigin() {
  const d = await discovery();
  const ev = d && d.services && d.services.evolve;
  if (!ev) return null;
  return ev.url ? String(ev.url).replace(/\/+$/, '') : location.protocol + '//' + location.hostname + ':' + ev.port;
}

/** main.js 启动时问：本中心有没有自进化服务（没有就隐藏页签） */
export async function hasEvolve() { return !!(await evolveOrigin()); }

/** @param {string} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** @param {HTMLElement} el @param {string} what 页面叫什么 @param {string} hash 打开后落在哪一页 */
export async function renderLink(el, what, hash) {
  const origin = await evolveOrigin();
  const html = origin
    ? `${esc(what)}在自进化网站上，登录与本看板分开。<a href="${esc(origin + '/' + hash)}" target="_blank" rel="noopener" data-testid="evolve-link">打开 ${esc(origin)}</a>`
    : '本中心没有自进化服务。';
  el.innerHTML = `<div class="panel"><div class="evolve-host-note">${html}</div></div>`;
}

/** @param {HTMLElement} el */
export function init(el) { renderLink(el, '自进化中心', ''); }

export async function refresh() { /* 只是一个链接，没有可刷新的 */ }

export function navigate() { /* 没有子页 */ }

// @ts-check
// evolve.js —— 「自进化」页签适配器（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §4.4 / §6.5）。
// 自进化中心已拆为独立服务 cancong-evolve；本页签不含任何自进化代码，只做挂载：
//   /v1/discovery → services.evolve
//     · { port } ⇒ origin = 同协议 + location.hostname + port（中心两地两 IP 各回各的）→ import(origin/ui/mount.js) → mount()
//     · { url }  ⇒ 跨主机：Cookie 带不过去，页签只给「请直接访问」提示（绝对 URL 只供客户端上报）
//     · null     ⇒ 本中心没有共部署自进化：main.js 隐藏页签
// 两边由同一人锁步发版（MOUNT_API 不符就提示，不硬挂）。鉴权：ops_session Cookie 同主机跨端口自动带上，
// cancong-evolve 的 ops 提供者内省本服务 /v1/auth/me。

const MOUNT_API = 1;
const BOUNCE_KEY = 'cancongOps.evolveAuthBounce';
const BOUNCE_MS = 60 * 1000;

/** @type {HTMLElement} */ let root;
/** @type {{ refresh(): Promise<void>, navigate(r: string): void } | null} */ let handle = null;
/** @type {Promise<void>} */ let loading = Promise.resolve();
/** @type {Promise<any> | null} */ let discoveryP = null;

function discovery() {
  if (!discoveryP) discoveryP = fetch('/v1/discovery').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return discoveryP;
}

/** main.js 启动时问：本中心有没有共部署自进化（没有就隐藏页签） */
export async function hasEvolve() {
  const d = await discovery();
  return !!(d && d.services && d.services.evolve);
}

/** @param {string} html */
function note(html) { root.innerHTML = `<div class="panel"><div class="evolve-host-note">${html}</div></div>`; }
/** @param {string} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 401：先回中心登录页（带 next 回跳）；60 秒内又 401 = 登录了也不认（跨主机 / HTTPS 混用）⇒ 不再跳，免得死循环
function onUnauthorized() {
  let last = 0;
  try { last = Number(sessionStorage.getItem(BOUNCE_KEY)) || 0; } catch (_) { /* 无存储 */ }
  if (Date.now() - last < BOUNCE_MS) {
    note('已登录运营看板，但自进化服务不认这个会话——多半是浏览器访问地址与自进化服务不同主机，或 HTTPS 与 HTTP 混用。请直接访问自进化服务。');
    return;
  }
  try { sessionStorage.setItem(BOUNCE_KEY, String(Date.now())); } catch (_) { /* 无存储 */ }
  location.href = '/login.html?next=' + encodeURIComponent(location.href);
}

/** @param {string | undefined} sub */
async function load(sub) {
  const d = await discovery();
  const ev = d && d.services && d.services.evolve;
  if (!ev) { note('本中心没有共部署自进化服务。'); return; }
  if (ev.url) {
    note(`自进化服务部署在另一台机器，无法嵌在本看板里（登录态带不过去）。请直接访问 <a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.url)}</a>。`);
    return;
  }
  const origin = location.protocol + '//' + location.hostname + ':' + ev.port;
  let mod;
  try { mod = await import(origin + '/ui/mount.js'); } catch (e) {
    note(`自进化服务不可达：${esc(origin)}（${esc((e && e.message) || e)}）。<a href="#" id="evolve-retry">重试</a>`);
    const a = root.querySelector('#evolve-retry');
    if (a) a.addEventListener('click', (ev2) => { ev2.preventDefault(); loading = load(sub); });
    return;
  }
  if (mod.MOUNT_API !== MOUNT_API) { note(`自进化服务版本与本看板不匹配（挂载接口 ${esc(mod.MOUNT_API)}，本看板要 ${MOUNT_API}）：两边请同一窗口升级。`); return; }
  handle = await mod.mount(root, {
    apiBase: origin, embedded: true, route: sub,
    onNavigate: (r) => { history.replaceState(null, '', '#evolve/' + r); },
    onUnauthorized,
  });
}

/** @param {HTMLElement} el @param {string} [sub] 子页（#evolve/<sub>） */
export function init(el, sub) {
  root = el;
  note('加载自进化…');
  loading = load(sub).catch((e) => note('自进化页面加载失败：' + esc((e && e.message) || e)));
}

export async function refresh() {
  await loading;
  if (handle) await handle.refresh();
}

/** @param {string} sub */
export function navigate(sub) { if (handle && sub) handle.navigate(sub); }

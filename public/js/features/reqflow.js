// @ts-check
// reqflow.js —— 「需求研发」页签适配器（TechDemos docs/REQ-FLOW-DESIGN.md §8.3）。
// 与 evolve.js 同形（刻意小重复，不动「自进化」页签）：/v1/discovery → services.evolve →
// import(<evolve origin>/ui/mount-req.js) → mount()。本看板不含任何需求研发代码。
// 探测失败 / 挂载接口版本不符 / 自进化服务还没升级到带需求研发的版本 ⇒ 只在本页签内提示，不影响其他页签。

const MOUNT_API = 1;
const BOUNCE_KEY = 'cancongOps.reqflowAuthBounce';
const BOUNCE_MS = 60 * 1000;

/** @type {HTMLElement} */ let root;
/** @type {{ refresh(): Promise<void>, navigate(r: string): void } | null} */ let handle = null;
/** @type {Promise<void>} */ let loading = Promise.resolve();
/** @type {Promise<any> | null} */ let discoveryP = null;

function discovery() {
  if (!discoveryP) discoveryP = fetch('/v1/discovery').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return discoveryP;
}

/** main.js 启动时问：本中心有没有共部署自进化服务（需求研发跟它同一个服务；没有就隐藏页签） */
export async function hasReqflow() {
  const d = await discovery();
  return !!(d && d.services && d.services.evolve && d.services.evolve.port);
}

/** @param {string} html */
function note(html) { root.innerHTML = `<div class="panel"><div class="evolve-host-note">${html}</div></div>`; }
/** @param {string} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
  if (!ev || !ev.port) { note('本中心没有共部署自进化服务，需求研发看板不可用。'); return; }
  const origin = location.protocol + '//' + location.hostname + ':' + ev.port;
  let mod;
  try { mod = await import(origin + '/ui/mount-req.js'); } catch (e) {
    note(`需求研发页面加载不到：${esc(origin)}（${esc((e && e.message) || e)}）。自进化服务不可达，或尚未升级到带需求研发的版本。<a href="#" id="reqflow-retry">重试</a>`);
    const a = root.querySelector('#reqflow-retry');
    if (a) a.addEventListener('click', (ev2) => { ev2.preventDefault(); loading = load(sub); });
    return;
  }
  if (mod.MOUNT_API !== MOUNT_API) { note(`自进化服务版本与本看板不匹配（挂载接口 ${esc(mod.MOUNT_API)}，本看板要 ${MOUNT_API}）：两边请同一窗口升级。`); return; }
  handle = await mod.mount(root, {
    apiBase: origin, embedded: true, route: sub,
    onNavigate: (r) => { history.replaceState(null, '', '#reqflow/' + r); },
    onUnauthorized,
  });
}

/** @param {HTMLElement} el @param {string} [sub] 子页（#reqflow/<sub>） */
export function init(el, sub) {
  root = el;
  note('加载需求研发…');
  loading = load(sub).catch((e) => note('需求研发页面加载失败：' + esc((e && e.message) || e)));
}

export async function refresh() {
  await loading;
  if (handle) await handle.refresh();
}

/** @param {string} sub */
export function navigate(sub) { if (handle && sub) handle.navigate(sub); }

// @ts-check
// main.js —— 装配：hash tab 路由（#tab 或 #tab/子页）+ 60s 自动刷新（只刷激活页；document.hidden 暂停）

import { onRangeChange } from './core/range.js';
import { me, logout } from './core/auth.js';
import { openAccounts, openChangePassword } from './features/accounts.js';
import * as overview from './features/overview.js';
import * as trend from './features/trend.js';
import * as blueprints from './features/blueprints.js';
import * as users from './features/users.js';
import * as failures from './features/failures.js';
import * as installs from './features/installs.js';
import * as fw from './features/fw.js';
import * as evolve from './features/evolve.js';
import * as reqflow from './features/reqflow.js';
import * as release from './features/release.js';

const REFRESH_MS = 60 * 1000;
const PAGES = { overview, trend, blueprints, users, failures, fw, installs, evolve, reqflow, release };
/** @type {Record<string, boolean>} */
const inited = {};
let active = '';

// hash 第一段是页签，其余是子路由（目前只有「自进化」页签用：#evolve/clusters）
function parseHash() {
  const [h, ...rest] = location.hash.replace('#', '').split('/');
  const tab = Object.prototype.hasOwnProperty.call(PAGES, h) ? h : 'overview';
  return { tab, sub: rest.join('/') || undefined };
}

function show(tab, sub) {
  active = tab;
  for (const name of Object.keys(PAGES)) {
    const el = document.getElementById('page-' + name);
    if (el) el.classList.toggle('active', name === tab);
  }
  document.querySelectorAll('#tabs a').forEach((a) => {
    a.classList.toggle('active', /** @type {HTMLElement} */ (a).dataset.tab === tab);
  });
  const el = /** @type {HTMLElement} */ (document.getElementById('page-' + tab));
  if (!inited[tab]) { inited[tab] = true; PAGES[tab].init(el, sub); }
  else if (sub && PAGES[tab].navigate) PAGES[tab].navigate(sub);
  refreshActive();
}

async function refreshActive() {
  const hint = document.getElementById('refresh-hint');
  try {
    await PAGES[active].refresh();
    if (hint) hint.textContent = '更新于 ' + new Date().toLocaleTimeString();
  } catch (e) {
    if (hint) hint.textContent = '刷新失败';
    console.log('[dashboard] refresh error:', e);
  }
}

// 顶栏用户菜单：门禁已保证到此即已登录，me() 仅取用户名/角色装配 UI（401 时防御性回登录页）
async function initAuthUI() {
  let user;
  try { user = await me(); } catch (_) { location.href = '/login.html'; return; }
  const menu = document.getElementById('user-menu');
  document.getElementById('user-name').textContent = user.username;
  document.getElementById('user-avatar').textContent = (user.username[0] || '?').toUpperCase();
  document.getElementById('user-role').textContent = user.role === 'admin' ? '管理员' : '用户';
  if (menu) menu.hidden = false;

  const btn = document.getElementById('user-btn');
  const dropdown = document.getElementById('user-dropdown');
  const setOpen = (open) => { dropdown.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(dropdown.hidden); });
  dropdown.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => setOpen(false));

  if (user.role === 'admin') {
    const acc = document.getElementById('menu-accounts');
    acc.hidden = false;
    acc.addEventListener('click', () => { setOpen(false); openAccounts(); });
  } else {
    // 版本发布是运维动作（上传/发布服务端 requireAdmin），非管理员藏页签少一层困惑
    const rel = document.getElementById('tab-release');
    if (rel) rel.style.display = 'none';
  }
  document.getElementById('menu-password').addEventListener('click', () => { setOpen(false); openChangePassword(); });
  document.getElementById('menu-logout').addEventListener('click', async () => {
    try { await logout(); } catch (_) { /* 忽略：无论如何都回登录页 */ }
    location.href = '/login.html';
  });
}

window.addEventListener('hashchange', () => { const h = parseHash(); show(h.tab, h.sub); });
// 本中心没有共部署自进化（/v1/discovery 的 services.evolve 为 null）⇒ 隐藏页签
evolve.hasEvolve().then((yes) => { const a = document.getElementById('tab-evolve'); if (a && !yes) a.style.display = 'none'; });
reqflow.hasReqflow().then((yes) => { const a = document.getElementById('tab-reqflow'); if (a && !yes) a.style.display = 'none'; });
onRangeChange(() => refreshActive());

setInterval(() => { if (!document.hidden) refreshActive(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshActive(); });

initAuthUI();
{ const h = parseHash(); show(h.tab, h.sub); }

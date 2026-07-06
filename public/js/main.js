// @ts-check
// main.js —— 装配：hash tab 路由 + 60s 自动刷新（只刷激活页；document.hidden 暂停）

import { onRangeChange } from './core/range.js';
import { me, logout } from './core/auth.js';
import { openAccounts, openChangePassword } from './features/accounts.js';
import * as overview from './features/overview.js';
import * as trend from './features/trend.js';
import * as blueprints from './features/blueprints.js';
import * as users from './features/users.js';
import * as failures from './features/failures.js';
import * as installs from './features/installs.js';

const REFRESH_MS = 60 * 1000;
const PAGES = { overview, trend, blueprints, users, failures, installs };
/** @type {Record<string, boolean>} */
const inited = {};
let active = '';

function currentTab() {
  const h = location.hash.replace('#', '');
  return Object.prototype.hasOwnProperty.call(PAGES, h) ? h : 'overview';
}

function show(tab) {
  active = tab;
  for (const name of Object.keys(PAGES)) {
    const el = document.getElementById('page-' + name);
    if (el) el.classList.toggle('active', name === tab);
  }
  document.querySelectorAll('#tabs a').forEach((a) => {
    a.classList.toggle('active', /** @type {HTMLElement} */ (a).dataset.tab === tab);
  });
  const el = /** @type {HTMLElement} */ (document.getElementById('page-' + tab));
  if (!inited[tab]) { inited[tab] = true; PAGES[tab].init(el); }
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
  }
  document.getElementById('menu-password').addEventListener('click', () => { setOpen(false); openChangePassword(); });
  document.getElementById('menu-logout').addEventListener('click', async () => {
    try { await logout(); } catch (_) { /* 忽略：无论如何都回登录页 */ }
    location.href = '/login.html';
  });
}

window.addEventListener('hashchange', () => show(currentTab()));
onRangeChange(() => refreshActive());

setInterval(() => { if (!document.hidden) refreshActive(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshActive(); });

initAuthUI();
show(currentTab());

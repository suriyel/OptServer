// @ts-check
// main.js —— 装配：hash tab 路由 + 60s 自动刷新（只刷激活页；document.hidden 暂停）

import { onRangeChange } from './core/range.js';
import * as overview from './features/overview.js';
import * as trend from './features/trend.js';
import * as failures from './features/failures.js';
import * as installs from './features/installs.js';

const REFRESH_MS = 60 * 1000;
const PAGES = { overview, trend, failures, installs };
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

window.addEventListener('hashchange', () => show(currentTab()));
onRangeChange(() => refreshActive());

setInterval(() => { if (!document.hidden) refreshActive(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshActive(); });

show(currentTab());

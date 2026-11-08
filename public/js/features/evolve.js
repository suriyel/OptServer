// @ts-check
// evolve.js —— 自进化中心页（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §5.5 五页签）。
// 顶栏只占一个页签「自进化」，页内再分五个子页签；子页签模块各自 init(el, ctx) / refresh()，
// 与顶层页签同一套约定。写按钮只给管理员渲染（服务端写口 requireAdmin 才是真正的闸）。

import { me } from '../core/auth.js';
import * as clusters from './evolve/clusters.js';
import * as fw from './evolve/fw.js';
import * as holdout from './evolve/holdout.js';
import * as queue from './evolve/queue.js';
import * as config from './evolve/config.js';

const SUBS = [
  { key: 'clusters', label: '补丁簇', mod: clusters },
  { key: 'fw', label: '框架问题', mod: fw },
  { key: 'holdout', label: '留出对照', mod: holdout },
  { key: 'queue', label: '队列', mod: queue },
  { key: 'config', label: '配置', mod: config },
];
const KEY = 'cancongOps.evolveSub';

/** @type {HTMLElement} */ let root;
/** @type {Record<string, boolean>} */ const inited = {};
let active = 'clusters';
/** @type {Promise<{isAdmin: boolean}>} */ let ctxP;

export function init(el) {
  root = el;
  try { const s = localStorage.getItem(KEY); if (s && SUBS.some((x) => x.key === s)) active = s; } catch (_) { /* 无存储 */ }
  el.innerHTML = '<div class="evo-subbar"><div class="metric-seg" id="evo-subs">'
    + SUBS.map((s) => `<button data-sub="${s.key}">${s.label}</button>`).join('')
    + '</div></div>'
    + SUBS.map((s) => `<div class="evo-sub" id="evo-sub-${s.key}" hidden></div>`).join('');
  el.querySelector('#evo-subs').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button[data-sub]');
    if (!b) return;
    active = /** @type {HTMLElement} */ (b).dataset.sub || 'clusters';
    try { localStorage.setItem(KEY, active); } catch (_) { /* 无存储 */ }
    refresh().catch(() => { /* 子页自己渲染错误框 */ });
  });
  ctxP = me().then((u) => ({ isAdmin: !!u && u.role === 'admin' })).catch(() => ({ isAdmin: false }));
}

export async function refresh() {
  const ctx = await ctxP;
  root.querySelectorAll('#evo-subs button').forEach((b) => {
    b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.sub === active);
  });
  for (const s of SUBS) {
    const box = /** @type {HTMLElement} */ (root.querySelector('#evo-sub-' + s.key));
    box.hidden = s.key !== active;
    if (s.key === active && !inited[s.key]) { inited[s.key] = true; s.mod.init(box, ctx); }
  }
  const cur = SUBS.find((s) => s.key === active);
  if (cur) await cur.mod.refresh();
}

// @ts-check
// installs.js —— 实例页：明细表（表头点击排序 + 输入过滤，纯前端，千行无压力）；
// last_seen < 10min 高亮在线点（与 /stats/overview 的在线口径一致）

import { getStats } from '../core/api.js';
import { escapeHtml, fmtLocalFromIso, fmtAgo } from '../core/fmt.js';

const ONLINE_MS = 10 * 60 * 1000;

const COLUMNS = [
  { key: 'user', label: '用户', num: false },
  { key: 'host', label: '主机', num: false },
  { key: 'appVersion', label: '版本', num: false },
  { key: 'platform', label: '平台', num: false },
  { key: 'channel', label: '渠道', num: false },
  { key: 'liveSessions', label: '活动会话', num: true },
  { key: 'lastSeen', label: '最后在线', num: false },
  { key: 'firstSeen', label: '首次上线', num: false },
];

/** @type {HTMLElement} */ let root;
/** @type {any[]} */ let rows = [];
let sortKey = 'lastSeen';
let sortDesc = true;
let filterText = '';

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="panel">
      <h3 id="in-title">实例明细</h3>
      <input class="filter-input" id="in-filter" placeholder="过滤：用户 / 主机 / 版本…">
      <div id="in-table"></div>
    </div>
    <div class="error-box" id="in-error"></div>`;
  el.querySelector('#in-filter').addEventListener('input', (e) => {
    filterText = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
    renderTable();
  });
  el.querySelector('#in-table').addEventListener('click', (e) => {
    const th = /** @type {HTMLElement} */ (e.target).closest('th');
    if (!th || !th.dataset.key) return;
    if (sortKey === th.dataset.key) sortDesc = !sortDesc;
    else { sortKey = th.dataset.key; sortDesc = true; }
    renderTable();
  });
}

export async function refresh() {
  const errBox = root.querySelector('#in-error');
  errBox.textContent = '';
  try {
    const d = await getStats('/installs');
    rows = d.installs;
    renderTable();
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function renderTable() {
  const now = Date.now();
  let list = rows;
  if (filterText) {
    list = rows.filter((r) => [r.user, r.host, r.appVersion, r.platform, r.channel]
      .some((v) => String(v || '').toLowerCase().includes(filterText)));
  }
  const sorted = list.slice().sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv : String(av || '').localeCompare(String(bv || ''));
    return sortDesc ? -cmp : cmp;
  });

  const online = rows.filter((r) => now - new Date(r.lastSeen).getTime() < ONLINE_MS).length;
  root.querySelector('#in-title').textContent =
    `实例明细（共 ${rows.length}，在线 ${online}${filterText ? '，过滤后 ' + sorted.length : ''}）`;

  const head = COLUMNS.map((c) => `<th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}">${c.label}`
    + (sortKey === c.key ? `<span class="arrow">${sortDesc ? '▼' : '▲'}</span>` : '') + '</th>').join('');
  const body = sorted.map((r) => {
    const isOnline = now - new Date(r.lastSeen).getTime() < ONLINE_MS;
    return `<tr>
      <td><span class="dot${isOnline ? ' online' : ''}"></span>${escapeHtml(r.user)}</td>
      <td>${escapeHtml(r.host)}</td>
      <td>${escapeHtml(r.appVersion || '')}</td>
      <td>${escapeHtml(r.platform || '')}</td>
      <td>${escapeHtml(r.channel || '')}</td>
      <td class="num">${r.liveSessions ?? 0}</td>
      <td title="${escapeHtml(r.lastSeen)}">${isOnline ? '在线' : fmtAgo(r.lastSeen)}</td>
      <td>${fmtLocalFromIso(r.firstSeen)}</td>
    </tr>`;
  }).join('');
  root.querySelector('#in-table').innerHTML = sorted.length
    ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '<div class="empty">无匹配实例</div>';
}

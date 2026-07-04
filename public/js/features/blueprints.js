// @ts-check
// blueprints.js —— 工作流页（对外术语；内部 blueprintId）：各工作流的运行/失败/E2E/中断/token
// 表头点击排序（纯前端，复用 installs 范式）。数据来自 /v1/stats/blueprints。

import { getStats } from '../core/api.js';
import { escapeHtml, fmtInt, fmtDuration } from '../core/fmt.js';
import { rangeParams } from '../core/range.js';

// num 列参与数值排序；activeMs 展示为时长；tokens = in+out
const COLUMNS = [
  { key: 'blueprintId', label: '工作流', num: false },
  { key: 'runs', label: '运行', num: true },
  { key: 'runsDone', label: '成功', num: true },
  { key: 'runsFailed', label: '失败run', num: true },
  { key: 'runsHalted', label: '中止', num: true },
  { key: 'failures', label: '失败事件', num: true },
  { key: 'activeMs', label: '活跃时长', num: true, fmt: fmtDuration },
  { key: 'interruptions', label: '中断', num: true },
  { key: 'tokens', label: 'Token', num: true },
];

/** @type {HTMLElement} */ let root;
/** @type {any[]} */ let rows = [];
let sortKey = 'runs';
let sortDesc = true;

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="panel">
      <h3 id="bp-title">工作流</h3>
      <div id="bp-table"></div>
    </div>
    <div class="error-box" id="bp-error"></div>`;
  el.querySelector('#bp-table').addEventListener('click', (e) => {
    const th = /** @type {HTMLElement} */ (e.target).closest('th');
    if (!th || !th.dataset.key) return;
    if (sortKey === th.dataset.key) sortDesc = !sortDesc;
    else { sortKey = th.dataset.key; sortDesc = true; }
    renderTable();
  });
}

export async function refresh() {
  const errBox = root.querySelector('#bp-error');
  errBox.textContent = '';
  try {
    const d = await getStats('/stats/blueprints', rangeParams());
    rows = d.blueprints;
    renderTable();
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function renderTable() {
  const sorted = rows.slice().sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv : String(av || '').localeCompare(String(bv || ''));
    return sortDesc ? -cmp : cmp;
  });
  root.querySelector('#bp-title').textContent = `工作流（共 ${rows.length}）`;

  const head = COLUMNS.map((c) => `<th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}">${c.label}`
    + (sortKey === c.key ? `<span class="arrow">${sortDesc ? '▼' : '▲'}</span>` : '') + '</th>').join('');
  const body = sorted.map((r) => '<tr>' + COLUMNS.map((c) => {
    if (!c.num) return `<td>${escapeHtml(r[c.key])}</td>`;
    const v = c.fmt ? c.fmt(r[c.key]) : fmtInt(r[c.key]);
    return `<td class="num">${v}</td>`;
  }).join('') + '</tr>').join('');
  root.querySelector('#bp-table').innerHTML = sorted.length
    ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '<div class="empty">范围内无工作流运行</div>';
}

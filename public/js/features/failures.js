// @ts-check
// failures.js —— 失败页：kind 分布条形、按版本失败率表、最近失败事件表
// （行留 data-event-id：v2 一键提单的入口位）

import { getStats } from '../core/api.js';
import { escapeHtml, fmtInt, fmtPct, fmtLocalFromIso } from '../core/fmt.js';
import { EC as COLORS } from '../core/echarts.js';
import { rangeParams } from '../core/range.js';

/** @type {HTMLElement} */ let root;

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="panel-row">
      <div class="panel"><h3>失败类型分布</h3><div id="fa-kinds"></div></div>
      <div class="panel"><h3>按版本失败率（失败数 / run 数）</h3><div id="fa-versions"></div></div>
    </div>
    <div class="panel"><h3>最近失败事件（最多 100 条）</h3><div id="fa-recent"></div></div>
    <div class="error-box" id="fa-error"></div>`;
}

export async function refresh() {
  const errBox = root.querySelector('#fa-error');
  errBox.textContent = '';
  try {
    const d = await getStats('/stats/failures', rangeParams());
    renderKinds(d.kinds);
    renderByVersion(d.byVersion);
    renderRecent(d.recent);
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function renderKinds(kinds) {
  const box = root.querySelector('#fa-kinds');
  if (!kinds.length) { box.innerHTML = '<div class="empty">范围内无失败事件 🎉</div>'; return; }
  const max = Math.max(...kinds.map((x) => x.n), 1);
  box.innerHTML = '<div class="barlist">' + kinds.map((x) => `
    <div class="bar-row">
      <span class="bar-name" title="${escapeHtml(x.kind)}">${escapeHtml(x.kind)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(x.n / max * 100).toFixed(1)}%;background:${COLORS.red}"></div></div>
      <span class="bar-val">${fmtInt(x.n)}</span>
    </div>`).join('') + '</div>';
}

function renderByVersion(rows) {
  const box = root.querySelector('#fa-versions');
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  box.innerHTML = `<table><thead><tr>
      <th>版本</th><th class="num">失败数</th><th class="num">run 数</th><th class="num">失败率</th>
    </tr></thead><tbody>` + rows.map((r) => `
    <tr><td>${escapeHtml(r.version)}</td>
      <td class="num">${fmtInt(r.failures)}</td>
      <td class="num">${fmtInt(r.runs)}</td>
      <td class="num">${fmtPct(r.rate)}</td></tr>`).join('') + '</tbody></table>';
}

function renderRecent(rows) {
  const box = root.querySelector('#fa-recent');
  if (!rows.length) { box.innerHTML = '<div class="empty">范围内无失败事件 🎉</div>'; return; }
  box.innerHTML = `<table><thead><tr>
      <th>时间</th><th>用户</th><th>工作流</th><th>来源</th><th>类型</th><th>说明</th><th>版本</th>
    </tr></thead><tbody>` + rows.map((r) => {
    const p = r.payload || {};
    return `<tr data-event-id="${escapeHtml(r.eventId)}">
      <td>${fmtLocalFromIso(r.serverTs)}</td>
      <td>${escapeHtml(r.user)}@${escapeHtml(r.host)}</td>
      <td>${escapeHtml(p.blueprintId || '—')}</td>
      <td>${escapeHtml(p.source || '')}</td>
      <td>${escapeHtml(p.kind || '')}</td>
      <td title="${escapeHtml(p.reason || '')}">${escapeHtml(String(p.reason || '').slice(0, 60))}</td>
      <td>${escapeHtml(r.appVersion || '')}</td></tr>`;
  }).join('') + '</tbody></table>';
}

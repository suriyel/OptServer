// @ts-check
// failures.js —— 失败页：kind 分布条形、按版本失败率表、最近失败事件表
// （行留 data-event-id：v2 一键提单的入口位）

import { getStats, makeGuard } from '../core/api.js';
import { escapeHtml, fmtInt, fmtPct, fmtLocalFromIso } from '../core/fmt.js';
import { EC as COLORS } from '../core/echarts.js';
import { rangeParams } from '../core/range.js';
import { downloadCsv } from '../core/download.js';

/** @type {HTMLElement} */ let root;
/** 代际守卫：切档位时 90 天查询比 7 天慢，落地顺序与发起顺序相反，旧快照会覆盖新结果 */
const guard = makeGuard();

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="panel-row">
      <div class="panel"><h3>失败类型分布</h3><div id="fa-kinds"></div></div>
      <div class="panel"><h3>按版本失败率（失败数 / run 数）</h3><div id="fa-versions"></div></div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h3>最近失败事件（最多 100 条）</h3>
        <button class="export-btn" id="fa-export">导出 CSV</button>
      </div>
      <div id="fa-recent"></div>
    </div>
    <div class="error-box" id="fa-error"></div>`;
  // 导出范围内全部失败事件明细（突破页面 100 条上限）
  el.querySelector('#fa-export').addEventListener('click', () => downloadCsv('failures', rangeParams()));
}

export async function refresh() {
  const errBox = root.querySelector('#fa-error');
  errBox.textContent = '';
  const g = guard.next();
  try {
    const d = await getStats('/stats/failures', rangeParams());
    if (guard.stale(g)) return; // 有更新的一次在途/已落地，丢弃本次
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
    // update_apply{ok:false} 与 failure_event 同列（服务端 recent 已按 type 区分）
    const isUpd = r.type === 'update_apply';
    const source = isUpd ? 'auto-update' : (p.source || '');
    const kind = isUpd ? ('update:' + (p.reason || 'unknown')) : (p.kind || '');
    const desc = isUpd
      ? `${p.from || '?'} → ${p.to || '?'}（第 ${p.attempts != null ? p.attempts : '?'} 次尝试）`
      : String(p.reason || '');
    return `<tr data-event-id="${escapeHtml(r.eventId)}">
      <td>${fmtLocalFromIso(r.serverTs)}</td>
      <td>${escapeHtml(r.user)}@${escapeHtml(r.host)}</td>
      <td>${escapeHtml(p.blueprintId || '—')}</td>
      <td>${escapeHtml(source)}</td>
      <td>${escapeHtml(kind)}</td>
      <td title="${escapeHtml(desc)}">${escapeHtml(desc.slice(0, 60))}</td>
      <td>${escapeHtml(r.appVersion || '')}</td></tr>`;
  }).join('') + '</tbody></table>';
}

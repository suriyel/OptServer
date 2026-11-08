// @ts-check
// evolve/queue.js —— 队列子页（§5.3 / §5.5）：待处理样本、失败样本、批次记录（状态 / 工作流 / 样本数 / 中心 runId / 耗时 / 失败原因）；
// 管理员：「立即处理」（不等每日窗口）、失败样本「重新排队」。
// 顶部执行器体检条（§11.2 D2）：红灯时「立即处理」置灰并写明原因。

import { getStats, makeGuard, send } from '../../core/api.js';
import { escapeHtml, fmtInt, fmtLocalFromIso, fmtDuration } from '../../core/fmt.js';
import { healthBarHtml, copyFrom } from './health.js';

const PAGE = 30;
const STATUS = { running: ['evo-warn', '处理中'], done: ['evo-ok', '完成'], failed: ['evo-red', '失败'] };
/** @type {HTMLElement} */ let root;
let isAdmin = false;
let offset = 0;
let canRun = true;
const guard = makeGuard();

export function init(el, ctx) {
  root = el; isAdmin = ctx.isAdmin;
  el.innerHTML = `<div class="panel" id="evq-health"></div><div class="panel"><div class="panel-head"><h3>待处理</h3>
      ${isAdmin ? '<button class="export-btn" id="evq-run">立即处理</button>' : ''}</div>
      <div id="evq-pending"></div><div class="evo-msg" id="evq-msg"></div></div>
    <div class="panel"><div class="panel-head"><h3>批次</h3></div><div id="evq-list"></div><div class="evo-pager" id="evq-pager"></div></div>
    <div class="error-box" id="evq-error"></div>`;
  el.addEventListener('click', onClick);
}

export async function refresh() {
  const err = root.querySelector('#evq-error'); err.textContent = '';
  const g = guard.next();
  try {
    const [d, h] = await Promise.all([
      getStats('/evolve/queue', { limit: String(PAGE), offset: String(offset) }),
      getStats('/evolve/health').catch(() => null),
    ]);
    if (guard.stale(g)) return;
    canRun = !h || h.canRun;
    const hb = root.querySelector('#evq-health');
    hb.innerHTML = healthBarHtml(h, isAdmin); hb.hidden = !h;
    renderPending(d);
    renderList(d.rows || [], d.total || 0);
  } catch (e) { err.textContent = '加载失败：' + e.message; throw e; }
}

function renderPending(d) {
  const run = root.querySelector('#evq-run');
  if (run) {
    /** @type {HTMLButtonElement} */ (run).disabled = !!d.running || !canRun;
    run.textContent = d.running ? '处理中…' : '立即处理';
    run.title = canRun ? '' : '执行器体检未过（见上方），修好后再处理';
  }
  const failed = new Map((d.failed || []).map((r) => [r.bpId, r.n]));
  const bps = [...new Set([...(d.queued || []).map((r) => r.bpId), ...failed.keys()])];
  const box = root.querySelector('#evq-pending');
  if (!bps.length) { box.innerHTML = '<div class="empty">没有待处理的新签名（已归簇的签名再入库只加计数，不进队列）</div>'; return; }
  const queued = new Map((d.queued || []).map((r) => [r.bpId, r.n]));
  box.innerHTML = '<table><thead><tr><th>工作流</th><th class="num">排队样本</th><th class="num">失败样本</th><th></th></tr></thead><tbody>'
    + bps.map((bp) => `<tr><td class="mono">${escapeHtml(bp || '?')}</td><td class="num">${fmtInt(queued.get(bp) || 0)}</td>
      <td class="num">${failed.get(bp) ? `<span class="evo-red-text">${fmtInt(failed.get(bp))}</span>` : '0'}</td>
      <td>${isAdmin && failed.get(bp) ? `<button class="export-btn" data-requeue="${escapeHtml(bp)}">重新排队</button>` : ''}</td></tr>`).join('')
    + '</tbody></table>';
}

function renderList(rows, total) {
  const box = root.querySelector('#evq-list');
  if (!rows.length) { box.innerHTML = '<div class="empty">还没有处理过批次</div>'; root.querySelector('#evq-pager').innerHTML = ''; return; }
  box.innerHTML = `<table><thead><tr><th>#</th><th>状态</th><th>工作流</th><th class="num">样本</th><th class="num">新簇</th><th class="num">合成</th>
    <th>中心 runId</th><th>触发</th><th>开始</th><th class="num">耗时</th><th>失败原因</th></tr></thead><tbody>`
    + rows.map((b) => {
      const s = STATUS[b.status] || ['', b.status];
      const ms = b.endedAt && b.startedAt ? new Date(b.endedAt).getTime() - new Date(b.startedAt).getTime() : null;
      return `<tr${b.status === 'failed' ? ' class="evo-row-red"' : ''}><td>${b.id}</td><td><span class="pill ${s[0]}">${s[1]}</span></td>
        <td class="mono">${escapeHtml(b.bpId || '—')}</td><td class="num">${fmtInt(b.samples)}</td><td class="num">${fmtInt(b.newClusters)}</td>
        <td class="num">${fmtInt(b.synthesized)}</td><td class="mono">${escapeHtml((b.runId || '').slice(0, 8))}</td>
        <td>${b.trigger === 'window' ? '每日窗口' : '立即处理'}</td><td class="muted">${escapeHtml(fmtLocalFromIso(b.startedAt))}</td>
        <td class="num">${ms == null ? '—' : escapeHtml(fmtDuration(ms))}</td><td class="evo-err-cell">${escapeHtml(b.error || '')}</td></tr>`;
    }).join('') + '</tbody></table>';
  const pages = Math.ceil(total / PAGE); const cur = Math.floor(offset / PAGE) + 1;
  root.querySelector('#evq-pager').innerHTML = pages > 1
    ? `<button class="export-btn" data-page="-1" ${cur <= 1 ? 'disabled' : ''}>上一页</button><span class="muted">${cur} / ${pages}</span>`
      + `<button class="export-btn" data-page="1" ${cur >= pages ? 'disabled' : ''}>下一页</button>` : '';
}

async function onClick(e) {
  const t = /** @type {HTMLElement} */ (e.target);
  const msg = root.querySelector('#evq-msg');
  const cp = t.closest('button[data-copy]');
  if (cp) return copyFrom(root, /** @type {HTMLElement} */ (cp).dataset.copy || '', msg);
  if (t.closest('#evh-refresh')) {
    try { await send('POST', '/evolve/health/refresh'); msg.textContent = '已重新体检'; }
    catch (er) { msg.textContent = '体检失败：' + er.message; }
    return refresh().catch(() => {});
  }
  if (t.closest('#evq-run')) {
    try { await send('POST', '/evolve/queue/run'); msg.textContent = '已开始处理（每批跑完自动入库，可稍后刷新查看）'; }
    catch (er) { msg.textContent = '启动失败：' + er.message; }
    return refresh().catch(() => {});
  }
  const rq = t.closest('button[data-requeue]');
  if (rq) {
    try { const r = await send('POST', '/evolve/queue/requeue', { bpId: /** @type {HTMLElement} */ (rq).dataset.requeue }); msg.textContent = '已重新排队 ' + r.requeued + ' 条'; }
    catch (er) { msg.textContent = '操作失败：' + er.message; }
    return refresh().catch(() => {});
  }
  const pg = t.closest('button[data-page]');
  if (pg) { offset = Math.max(0, offset + Number(/** @type {HTMLElement} */ (pg).dataset.page) * PAGE); return refresh().catch(() => {}); }
}

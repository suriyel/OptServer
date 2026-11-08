// @ts-check
// fw.js —— 框架问题页签（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §6.3）：签名排名（次数 / 机器数 / 事后通过率 / 样本）；
// 管理员可标「已修复于 vX」，之后 ≥ vX 的客户端再报同签名 ⇒ 标红回归。框架问题不进 LLM，纯 SQL 聚合。
// 拆分前是自进化页的子页；自进化拆成独立服务 cancong-evolve 后，框架问题归框架维护者（本服务）。

import { getStats, makeGuard, send } from '../core/api.js';
import { escapeHtml, fmtInt, fmtLocalFromIso } from '../core/fmt.js';
import { me } from '../core/auth.js';

const PAGE = 50;
/** @type {HTMLElement} */ let root;
let isAdmin = false;
let offset = 0;
const guard = makeGuard();

export function init(el) {
  root = el;
  el.innerHTML = `<div class="panel"><div class="panel-head"><h3>框架问题（按次数）</h3></div>
    <div class="table-note">守卫误拒、启动失败等框架侧问题由客户端整合器确定性汇总上报，不受白名单约束；「事后通过」= 被拦后同节点最终推进了（误拒的便宜判据）。</div>
    <div id="fwi-list"></div><div class="fw-pager" id="fwi-pager"></div></div><div class="error-box" id="fwi-error"></div>`;
  el.addEventListener('click', onClick);
  me().then((u) => { isAdmin = !!u && u.role === 'admin'; }).catch(() => {});
}

export async function refresh() {
  const err = root.querySelector('#fwi-error'); err.textContent = '';
  const g = guard.next();
  try {
    const [d, u] = await Promise.all([getStats('/fw-issues', { limit: String(PAGE), offset: String(offset) }), me().catch(() => null)]);
    if (guard.stale(g)) return;
    isAdmin = !!u && u.role === 'admin';
    render(d.rows || [], d.total || 0);
  } catch (e) { err.textContent = '加载失败：' + e.message; throw e; }
}

function render(rows, total) {
  const box = root.querySelector('#fwi-list');
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无框架问题上报</div>'; root.querySelector('#fwi-pager').innerHTML = ''; return; }
  box.innerHTML = `<table><thead><tr><th>类别 / 规则</th><th>样本</th><th>工作流 / 节点</th><th class="num">次数</th>
    <th class="num">机器</th><th class="num">事后通过</th><th>修复</th><th>最近</th></tr></thead><tbody>`
    + rows.map((r) => {
      const pass = r.judged ? Math.round((r.passed / r.judged) * 100) + '%' : '—';
      const fix = r.regressedVersion
        ? `<span class="pill fw-red">回归 ${escapeHtml(r.regressedVersion)}</span> <span class="muted">（修于 ${escapeHtml(r.fixedIn)}）</span>`
        : (r.fixedIn ? `<span class="pill fw-ok">已修复于 ${escapeHtml(r.fixedIn)}</span>` : '');
      const form = isAdmin ? ` <input class="filter-input fw-ver" placeholder="x.y.z" data-ver="${escapeHtml(r.signature)}">`
        + `<button class="export-btn" data-fix="${escapeHtml(r.signature)}">标记</button>` : '';
      return `<tr${r.regressedVersion ? ' class="fw-row-red"' : ''}><td><span class="pill">${escapeHtml(r.category || '')}</span> ${escapeHtml(r.rule || '')}</td>
        <td class="mono fw-sample-cell">${escapeHtml(r.sample || '')}</td><td class="mono">${escapeHtml(r.bpId || '')} / ${escapeHtml(r.nodeId || '')}</td>
        <td class="num">${fmtInt(r.count)}</td><td class="num">${fmtInt(r.machines)}</td><td class="num">${pass}</td>
        <td><div class="fw-actions">${fix}${form}</div></td><td class="muted">${escapeHtml(fmtLocalFromIso(r.lastAt))}</td></tr>`;
    }).join('') + '</tbody></table><div class="fw-msg" id="fwi-msg"></div>';
  const pages = Math.ceil(total / PAGE); const cur = Math.floor(offset / PAGE) + 1;
  root.querySelector('#fwi-pager').innerHTML = pages > 1
    ? `<button class="export-btn" data-page="-1" ${cur <= 1 ? 'disabled' : ''}>上一页</button><span class="muted">${cur} / ${pages}</span>`
      + `<button class="export-btn" data-page="1" ${cur >= pages ? 'disabled' : ''}>下一页</button>` : '';
}

async function onClick(e) {
  const t = /** @type {HTMLElement} */ (e.target);
  const pg = t.closest('button[data-page]');
  if (pg) { offset = Math.max(0, offset + Number(/** @type {HTMLElement} */ (pg).dataset.page) * PAGE); return refresh().catch(() => {}); }
  const fix = t.closest('button[data-fix]');
  if (!fix) return;
  const sig = /** @type {HTMLElement} */ (fix).dataset.fix || '';
  const input = /** @type {HTMLInputElement|null} */ ([...root.querySelectorAll('input[data-ver]')].find((i) => /** @type {HTMLElement} */ (i).dataset.ver === sig) || null);
  try {
    await send('POST', '/fw-issues/' + encodeURIComponent(sig) + '/fixed', { version: input ? input.value.trim() : '' });
    return refresh().catch(() => {});
  } catch (er) { root.querySelector('#fwi-msg').textContent = '标记失败：' + er.message; }
}

// @ts-check
// evolve/clusters.js —— 补丁簇子页（§5.5）：未裁决簇的合成补丁 / 证据 / 机器与 run 数 / 本机批准率 / 审查标红；
// 管理员：采纳（进篮子）/ 驳回（须写理由）/ 搁置 / 重开；篮子按蓝图「推送」成市场分支或「导出补丁」。

import { getStats, makeGuard, send } from '../../core/api.js';
import { escapeHtml, fmtInt, fmtLocalFromIso } from '../../core/fmt.js';

const PAGE = 30;
const FILTERS = [
  { key: 'open', label: '未裁决' }, { key: 'adopted', label: '篮子' }, { key: 'pushed', label: '已推送' },
  { key: 'rejected', label: '已驳回' }, { key: 'parked', label: '搁置' }, { key: '', label: '全部' },
];
const STATUS = { open: '未裁决', adopted: '篮子中', pushed: '已推送', rejected: '已驳回', parked: '搁置' };
const FLAG = { 'gate-weakening': '削弱门禁', overfit: '过拟合', conflict: '与现有内容冲突', anchor: '锚点套不上', format: '格式坏' };

/** @type {HTMLElement} */ let root;
let isAdmin = false;
let filter = 'open';
let offset = 0;
/** @type {number|null} */ let openId = null;
const guard = makeGuard();

const rate = (c) => {
  const n = (c.applied || 0) + (c.rejected || 0);
  return n ? Math.round((c.applied / n) * 100) + '%' + ` <span class="muted">(${c.applied}/${n})</span>` : '<span class="muted">—</span>';
};
const review = (c) => {
  if (c.reviewPass == null) return '<span class="muted">未合成</span>';
  if (c.reviewPass) return '<span class="pill evo-ok">通过</span>';
  const flags = String(c.reviewFlags || '').split(',').filter(Boolean);
  return flags.map((f) => `<span class="pill evo-red">${escapeHtml(FLAG[f] || f)}</span>`).join(' ') || '<span class="pill evo-red">未通过</span>';
};

export function init(el, ctx) {
  root = el; isAdmin = ctx.isAdmin;
  el.innerHTML = `
    <div class="panel" id="evc-basket-panel"><div class="panel-head"><h3>待推送篮子</h3></div><div id="evc-basket"></div>
      <div class="evo-msg" id="evc-push-msg"></div></div>
    <div class="panel"><div class="panel-head"><h3>补丁簇</h3>
      <div class="metric-seg" id="evc-filter">${FILTERS.map((f) => `<button data-f="${f.key}">${f.label}</button>`).join('')}</div></div>
      <div id="evc-list"></div><div class="evo-pager" id="evc-pager"></div></div>
    <div class="error-box" id="evc-error"></div>`;
  el.querySelector('#evc-filter').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button[data-f]');
    if (!b) return;
    filter = /** @type {HTMLElement} */ (b).dataset.f || ''; offset = 0; openId = null;
    refresh().catch(() => {});
  });
  el.addEventListener('click', onClick);
}

export async function refresh() {
  const err = root.querySelector('#evc-error'); err.textContent = '';
  root.querySelectorAll('#evc-filter button').forEach((b) => b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.f === filter));
  const g = guard.next();
  try {
    const q = { limit: String(PAGE), offset: String(offset) };
    if (filter) q.status = filter;
    const d = await getStats('/evolve/clusters', q);
    if (guard.stale(g)) return;
    renderBasket(d.basket || []);
    renderList(d.rows || [], d.total || 0);
    if (openId != null) await renderDetail(openId);
  } catch (e) { err.textContent = '加载失败：' + e.message; throw e; }
}

// 推送结果行 #evc-push-msg 放在静态面板里：推完 refresh 篮子清空重绘，结果不能跟着被抹掉
function renderBasket(rows) {
  const box = root.querySelector('#evc-basket');
  if (!rows.length) { box.innerHTML = '<div class="empty">篮子是空的——在下面采纳补丁簇后，按工作流一次推送</div>'; return; }
  box.innerHTML = '<table><thead><tr><th>工作流</th><th class="num">已采纳簇</th><th></th></tr></thead><tbody>'
    + rows.map((r) => `<tr><td class="mono">${escapeHtml(r.bpId)}</td><td class="num">${fmtInt(r.n)}</td><td><div class="evo-actions">`
      + (isAdmin ? `<button class="export-btn" data-push="${escapeHtml(r.bpId)}">推送到市场</button>`
        + `<button class="export-btn" data-export="${escapeHtml(r.bpId)}">导出补丁</button>` : '<span class="muted">仅管理员可推送</span>')
      + '</div></td></tr>').join('') + '</tbody></table>';
}

function renderList(rows, total) {
  const box = root.querySelector('#evc-list');
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无补丁簇</div>'; root.querySelector('#evc-pager').innerHTML = ''; return; }
  box.innerHTML = `<table><thead><tr><th></th><th>簇</th><th>工作流 / 节点</th><th class="num">机器</th><th class="num">run</th>
    <th class="num">本机批准率</th><th>审查</th><th>状态</th><th>更新</th></tr></thead><tbody>`
    + rows.map((c) => `<tr class="row-x${c.id === openId ? ' open' : ''}" data-id="${c.id}">
      <td><span class="caret">${c.id === openId ? '▾' : '▸'}</span></td>
      <td>#${c.id} ${escapeHtml(c.title || '')}${c.resynth ? ' <span class="pill evo-warn">待重新合成</span>' : ''}</td>
      <td class="mono">${escapeHtml(c.bpId)} / ${escapeHtml(c.nodeId || '?')}</td>
      <td class="num">${fmtInt(c.machines)}</td><td class="num">${fmtInt(c.runs)}</td><td class="num">${rate(c)}</td>
      <td>${review(c)}</td><td>${escapeHtml(STATUS[c.status] || c.status)}</td><td class="muted">${escapeHtml(fmtLocalFromIso(c.updatedAt))}</td></tr>`
      + (c.id === openId ? `<tr class="detail-row"><td colspan="9"><div class="detail" id="evc-detail">加载中…</div></td></tr>` : ''))
      .join('') + '</tbody></table>';
  const pages = Math.ceil(total / PAGE); const cur = Math.floor(offset / PAGE) + 1;
  root.querySelector('#evc-pager').innerHTML = pages > 1
    ? `<button class="export-btn" data-page="-1" ${cur <= 1 ? 'disabled' : ''}>上一页</button><span class="muted">${cur} / ${pages}（共 ${total}）</span>`
      + `<button class="export-btn" data-page="1" ${cur >= pages ? 'disabled' : ''}>下一页</button>` : '';
}

async function renderDetail(id) {
  const box = root.querySelector('#evc-detail');
  if (!box) return;
  const c = await getStats('/evolve/clusters/' + id);
  const samples = (c.samples || []).map((s) => {
    const p = s.payload || {};
    const ev = (p.evidence || []).map((x) => `<li><span class="pill">${escapeHtml(x.kind || '')}</span> ${escapeHtml(x.text || '')}</li>`).join('');
    return `<div class="evo-sample"><div class="muted">${escapeHtml(s.installId || '')} · ${escapeHtml(s.appVersion || '')} · ${escapeHtml(fmtLocalFromIso(s.ts))} · ${escapeHtml(p.signal || '')}</div>
      <div>${escapeHtml(p.rationale || '')}</div>${ev ? `<ul class="evo-ev">${ev}</ul>` : ''}</div>`;
  }).join('');
  const acts = !isAdmin ? '' : `<div class="evo-actions">`
    + (['open', 'parked'].includes(c.status) ? `<button class="export-btn" data-act="adopt" data-id="${c.id}">采纳（进篮子）</button>` : '')
    + (['open', 'parked', 'adopted'].includes(c.status) ? `<input class="filter-input evo-reason" id="evc-reason" placeholder="驳回理由（必填）"><button class="export-btn" data-act="reject" data-id="${c.id}">驳回</button>` : '')
    + (['open', 'adopted'].includes(c.status) ? `<button class="export-btn" data-act="park" data-id="${c.id}">搁置</button>` : '')
    + (['rejected', 'parked', 'adopted'].includes(c.status) ? `<button class="export-btn" data-act="reopen" data-id="${c.id}">重开</button>` : '')
    + '</div>';
  box.innerHTML = `<div class="detail-title">合成补丁<span class="detail-note">基于上游 ${escapeHtml(c.baseVersion || '?')}</span></div>
    <p>${escapeHtml(c.synthSummary || '（尚未合成）')}</p>
    ${c.synthText ? `<pre class="evo-diff">${escapeHtml(c.synthText)}</pre>` : ''}
    ${c.reviewNotes ? `<div class="detail-title">审查意见</div><p>${escapeHtml(c.reviewNotes)}</p>` : ''}
    ${c.reason ? `<div class="detail-title">备注</div><p>${escapeHtml(c.reason)}</p>` : ''}
    ${c.branch ? `<div class="detail-title">推送分支</div><p class="mono">${escapeHtml(c.branch)}</p>` : ''}
    <div class="detail-title">证据样本<span class="detail-note">最近 5 条</span></div>${samples || '<div class="empty">无</div>'}${acts}
    <div class="evo-msg" id="evc-act-msg"></div>`;
}

async function onClick(e) {
  const t = /** @type {HTMLElement} */ (e.target);
  const row = t.closest('tr.row-x');
  if (row) { const id = Number(/** @type {HTMLElement} */ (row).dataset.id); openId = openId === id ? null : id; return refresh().catch(() => {}); }
  const pg = t.closest('button[data-page]');
  if (pg) { offset = Math.max(0, offset + Number(/** @type {HTMLElement} */ (pg).dataset.page) * PAGE); openId = null; return refresh().catch(() => {}); }
  const act = t.closest('button[data-act]');
  if (act) {
    const a = /** @type {HTMLElement} */ (act).dataset;
    const msg = root.querySelector('#evc-act-msg');
    const body = {};
    if (a.act === 'reject') {
      body.reason = /** @type {HTMLInputElement} */ (root.querySelector('#evc-reason')).value.trim();
      if (!body.reason) { msg.textContent = '请先填写驳回理由'; return; }
    }
    try { await send('POST', '/evolve/clusters/' + a.id + '/' + a.act, body); return refresh().catch(() => {}); }
    catch (er) { msg.textContent = '操作失败：' + er.message; return; }
  }
  const push = t.closest('button[data-push]');
  if (push) {
    const bp = /** @type {HTMLElement} */ (push).dataset.push || '';
    const msg = root.querySelector('#evc-push-msg');
    /** @type {HTMLButtonElement} */ (push).disabled = true;
    msg.textContent = '推送中：拉取市场最新版 → 套补丁 → 推分支…';
    try {
      const r = await send('POST', '/evolve/push/' + encodeURIComponent(bp));
      msg.textContent = '已推送 ' + r.branch + '（' + r.pushed.length + ' 个簇' + (r.skipped.length ? '；' + r.skipped.length + ' 个在新版上打不上，已退回重新合成' : '') + '）';
      return refresh().catch(() => {});
    } catch (er) { msg.textContent = '推送失败：' + er.message; /** @type {HTMLButtonElement} */ (push).disabled = false; return; }
  }
  const exp = t.closest('button[data-export]');
  if (exp) {
    const bp = /** @type {HTMLElement} */ (exp).dataset.export || '';
    const msg = root.querySelector('#evc-push-msg');
    // 不用 location.href 直跳：409（篮子空 / 基线取不到）回的是 JSON，直跳会把整页换成一段报错
    const res = await fetch('/v1/evolve/export/' + encodeURIComponent(bp));
    if (!res.ok) { const j = await res.json().catch(() => null); msg.textContent = '导出失败：' + ((j && j.error) || res.status); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob()); a.download = bp + '-evolve.patch';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    msg.textContent = '已导出 ' + bp + '-evolve.patch（在目标仓根执行 git apply）';
  }
}

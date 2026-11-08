// @ts-check
// evolve/config.js —— 配置子页（§5.5）：上报白名单、留出 p、批处理窗口、目标市场；审计日志（谁 / 何时 / 改了什么）。
// 非管理员：GET /v1/evolve/config 是 requireAdmin ⇒ 直接提示无权限（客户端拉的那份公开配置不含中心字段）。

import { getStats, makeGuard, send } from '../../core/api.js';
import { escapeHtml, fmtLocalFromIso } from '../../core/fmt.js';

const ACTION = {
  config: '改配置', 'cluster-adopt': '采纳', 'cluster-reject': '驳回', 'cluster-park': '搁置', 'cluster-reopen': '重开',
  'fw-fixed': '标记修复', 'queue-run': '立即处理', requeue: '重新排队', push: '推送', 'push-skip': '推送未成', export: '导出补丁',
};
/** @type {HTMLElement} */ let root;
let isAdmin = false;
const guard = makeGuard();

export function init(el, ctx) {
  root = el; isAdmin = ctx.isAdmin;
  if (!isAdmin) { el.innerHTML = '<div class="panel"><div class="empty">配置与审计日志仅管理员可见</div></div>'; return; }
  el.innerHTML = `<div class="panel"><div class="panel-head"><h3>中心配置</h3></div>
    <div class="rel-form">
      <label>上报白名单（工作流 id，每行一个；不在名单内的工作流客户端不上报补丁提案）<textarea id="evg-wl" rows="6"></textarea></label>
      <label>留出概率 p（0–0.5；客户端最晚 6 小时后拉到）<input id="evg-p" type="number" min="0" max="0.5" step="0.01"></label>
      <label>批处理窗口（每天几点，0–23）<input id="evg-hour" type="number" min="0" max="23" step="1"></label>
      <label>目标市场（留空 = 同机蚕丛登记的第一个市场，即官方市场）
        <input id="evg-mname" placeholder="名称"><input id="evg-murl" placeholder="仓库地址"><input id="evg-mref" placeholder="分支（可空）"></label>
      <div class="evo-actions"><button class="export-btn" id="evg-save">保存</button><span class="muted" id="evg-ver"></span></div>
      <div class="evo-msg" id="evg-msg"></div>
    </div></div>
    <div class="panel"><div class="panel-head"><h3>审计日志</h3></div><div id="evg-audit"></div></div>
    <div class="error-box" id="evg-error"></div>`;
  el.querySelector('#evg-save').addEventListener('click', save);
}

const $ = (id) => /** @type {HTMLInputElement} */ (root.querySelector('#' + id));

export async function refresh() {
  if (!isAdmin) return;
  const err = root.querySelector('#evg-error'); err.textContent = '';
  const g = guard.next();
  try {
    const d = await getStats('/evolve/config', { limit: '100' });
    if (guard.stale(g)) return;
    const c = d.config;
    if (document.activeElement && root.contains(document.activeElement)) { renderAudit(d.audit.rows || []); return; } // 正在编辑：不覆盖输入
    $('evg-wl').value = (c.uploadWhitelist || []).join('\n');
    $('evg-p').value = String(c.holdoutP);
    $('evg-hour').value = String(c.windowHour);
    $('evg-mname').value = c.market ? c.market.name : '';
    $('evg-murl').value = c.market ? c.market.url : '';
    $('evg-mref').value = c.market && c.market.ref ? c.market.ref : '';
    root.querySelector('#evg-ver').textContent = 'v' + c.version + (c.updatedBy ? ' · ' + c.updatedBy + ' 于 ' + fmtLocalFromIso(c.updatedAt) : '');
    renderAudit(d.audit.rows || []);
  } catch (e) { err.textContent = '加载失败：' + e.message; throw e; }
}

async function save() {
  const msg = root.querySelector('#evg-msg');
  const name = $('evg-mname').value.trim(); const url = $('evg-murl').value.trim(); const ref = $('evg-mref').value.trim();
  if (!!name !== !!url) { msg.textContent = '目标市场的名称与地址要么都填，要么都空'; return; }
  const body = {
    uploadWhitelist: $('evg-wl').value.split(/\s+/).map((s) => s.trim()).filter(Boolean),
    holdoutP: Number($('evg-p').value), windowHour: Number($('evg-hour').value),
    market: name ? Object.assign({ name, url }, ref ? { ref } : {}) : null,
  };
  try {
    // PUT 回的是客户端契约的扁平形（无 data 字段），这里只关心成功与否
    const res = await fetch('/v1/config/evolve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
    msg.textContent = '已保存为 v' + j.version;
    /** @type {HTMLElement} */ (document.activeElement || document.body).blur();
    return refresh();
  } catch (e) { msg.textContent = '保存失败：' + e.message; }
}

function renderAudit(rows) {
  const box = root.querySelector('#evg-audit');
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无记录</div>'; return; }
  box.innerHTML = '<table><thead><tr><th>时间</th><th>谁</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>'
    + rows.map((r) => `<tr><td class="muted">${escapeHtml(fmtLocalFromIso(r.ts))}</td><td>${escapeHtml(r.user || '')}</td>
      <td>${escapeHtml(ACTION[r.action] || r.action)}</td><td class="mono">${escapeHtml(r.target || '')}</td>
      <td class="mono evo-sample-cell">${escapeHtml(r.detail ? JSON.stringify(r.detail) : '')}</td></tr>`).join('')
    + '</tbody></table>';
}

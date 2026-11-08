// @ts-check
// evolve/health.js —— 执行器体检状态条（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §11.2 D2）。
// 队列页顶部画全量；补丁簇页只借 canPush 决定推送 / 导出是否置灰。升级命令只给复制，不代执行。

import { escapeHtml, fmtLocalFromIso } from '../../core/fmt.js';

const LEVEL = { ok: ['evo-ok', '正常'], warn: ['evo-warn', '注意'], red: ['evo-red', '异常'], na: ['', '不适用'] };

/** @returns {string} */
export function healthBarHtml(h, isAdmin) {
  if (!h) return '';
  const top = LEVEL[h.overall] || LEVEL.na;
  const rows = h.items.map((x, i) => {
    const lv = LEVEL[x.level] || LEVEL.na;
    return `<li><span class="pill ${lv[0]}">${lv[1]}</span> ${escapeHtml(x.msg)}`
      + (x.level !== 'ok' && x.hint ? `<div class="muted evo-health-hint">${escapeHtml(x.hint)}</div>` : '')
      + (x.cmd ? `<div class="evo-actions"><input class="filter-input evo-health-cmd" id="evh-cmd-${i}" readonly value="${escapeHtml(x.cmd)}">`
        + `<button class="export-btn" data-copy="evh-cmd-${i}">复制命令</button></div>` : '')
      + '</li>';
  }).join('');
  return `<div class="evo-health"><div class="evo-actions"><strong>执行器体检</strong><span class="pill ${top[0]}">${top[1]}</span>`
    + `<span class="muted">${escapeHtml(fmtLocalFromIso(h.at))}</span>`
    + (isAdmin ? '<button class="export-btn" id="evh-refresh">重新体检</button>' : '') + '</div>'
    + `<ul class="evo-health-list">${rows}</ul></div>`;
}

/** 复制：内网 http 不是安全上下文，clipboard 可能不可用 ⇒ 回落为选中输入框里的文本，让人手动 Ctrl+C */
export async function copyFrom(root, id, msgEl) {
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('#' + id));
  if (!input) return;
  try {
    if (!navigator.clipboard) throw new Error('no clipboard');
    await navigator.clipboard.writeText(input.value);
    if (msgEl) msgEl.textContent = '已复制升级命令（到中心机上执行，需要 sudo）';
  } catch (_) {
    input.focus(); input.select();
    if (msgEl) msgEl.textContent = '浏览器不允许直接复制：命令已选中，请按 Ctrl+C';
  }
}

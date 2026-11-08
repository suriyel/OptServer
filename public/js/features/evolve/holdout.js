// @ts-check
// evolve/holdout.js —— 留出对照子页（§4.4 / §5.5，只读）：每「工作流 + 节点」注入 vs 留出的首轮通过率、
// 平均打回、样本量、差值 95% 置信区间。任一臂样本不足 ⇒ 明示「样本不足，不给结论」（不画看着像结论的数）。

import { getStats, makeGuard } from '../../core/api.js';
import { escapeHtml, fmtInt } from '../../core/fmt.js';
import { rangeParams } from '../../core/range.js';

const VERDICT = { helps: ['evo-ok', '注入有帮助'], hurts: ['evo-red', '注入有害'], inconclusive: ['', '无显著差异'] };
/** @type {HTMLElement} */ let root;
const guard = makeGuard();

const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
const num = (x) => (x == null ? '—' : x.toFixed(2));

export function init(el) {
  root = el;
  el.innerHTML = `<div class="panel"><div class="panel-head"><h3>留出对照（随顶栏范围）</h3></div>
    <div class="table-note" id="evh-note"></div><div id="evh-list"></div></div><div class="error-box" id="evh-error"></div>`;
}

export async function refresh() {
  const err = root.querySelector('#evh-error'); err.textContent = '';
  const g = guard.next();
  try {
    const d = await getStats('/evolve/holdout', rangeParams());
    if (guard.stale(g)) return;
    root.querySelector('#evh-note').textContent = '客户端每次 spawn 以服务端下发的概率不注入经验（留出）。首轮通过 = 该节点首个访次就推进、无门禁失败无打回；'
      + '每臂至少 ' + d.minArmN + ' 个样本才计算置信区间。';
    render(d.rows || []);
  } catch (e) { err.textContent = '加载失败：' + e.message; throw e; }
}

function render(rows) {
  const box = root.querySelector('#evh-list');
  if (!rows.length) { box.innerHTML = '<div class="empty">范围内没有带留出摘要的运行</div>'; return; }
  box.innerHTML = `<table><thead><tr><th>工作流 / 节点</th><th class="num">注入 n</th><th class="num">注入首轮通过</th><th class="num">注入平均打回</th>
    <th class="num">留出 n</th><th class="num">留出首轮通过</th><th class="num">留出平均打回</th><th class="num">差值（95% CI）</th><th>结论</th></tr></thead><tbody>`
    + rows.map((r) => {
      const v = r.verdict === 'insufficient' ? '<span class="muted">样本不足，不给结论</span>'
        : `<span class="pill ${VERDICT[r.verdict][0]}">${VERDICT[r.verdict][1]}</span>`;
      const diff = r.diff == null ? '—' : `${(r.diff * 100).toFixed(1)}pp <span class="muted">[${(r.ci[0] * 100).toFixed(1)}, ${(r.ci[1] * 100).toFixed(1)}]</span>`;
      return `<tr><td class="mono">${escapeHtml(r.bpId)} / ${escapeHtml(r.nodeId)}</td>
        <td class="num">${fmtInt(r.inj.n)}</td><td class="num">${pct(r.inj.passRate)}</td><td class="num">${num(r.inj.avgRewinds)}</td>
        <td class="num">${fmtInt(r.hold.n)}</td><td class="num">${pct(r.hold.passRate)}</td><td class="num">${num(r.hold.avgRewinds)}</td>
        <td class="num">${diff}</td><td>${v}</td></tr>`;
    }).join('') + '</tbody></table>';
}

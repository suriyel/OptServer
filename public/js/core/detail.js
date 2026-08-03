// @ts-check
// detail.js —— 明细表「点行展开」详情面板的公共件（工作流页 / 用户页共用）。
// 只放纯展示件；图表实例的生死由各页自己管（一次只开一行，故各页至多一个实例）。

import { escapeHtml, fmtDelta } from './fmt.js';

/** 'YYYY-MM-DD' → 'M/D'（日曲线 x 轴标签） @param {string} day */
export function mdLabel(day) { const [, m, d] = day.split('-'); return Number(m) + '/' + Number(d); }

/**
 * 本期 vs 上期对比条。数据来自列表接口已带回的 cur/prev，展开时**不再发请求**。
 * @param {any} cur @param {any} prev
 * @param {{key:string,label:string,fmt:(n:number)=>string}[]} metrics
 */
export function cmpGrid(cur, prev, metrics) {
  return '<div class="cmp-grid">' + metrics.map((m) => {
    const c = (cur && cur[m.key]) || 0, p = (prev && prev[m.key]) || 0;
    const d = fmtDelta(c, p, m.fmt);
    return `<div class="cmp-cell">
      <div class="cmp-label">${escapeHtml(m.label)}</div>
      <div class="cmp-val">${m.fmt(p)}<span class="cmp-arrow">→</span>${m.fmt(c)}</div>
      <div class="cmp-delta ${d.cls}">${d.text}</div>
    </div>`;
  }).join('') + '</div>';
}

/**
 * 表下方口径脚注：说清「总量含当日、环比不含当日」这条分叉，否则两个数字对不上时没人查得出原因。
 * @param {{cur:{from:string,to:string},prev:{from:string,to:string}}|null} compare
 */
export function rangeNote(compare) {
  if (!compare) return '<div class="table-note">区间内无完整自然日，不计环比。</div>';
  return `<div class="table-note">总量含当日（当日数据不完整）；环比 = 本期 ${compare.cur.from} ~ ${compare.cur.to}`
    + ` vs 上期 ${compare.prev.from} ~ ${compare.prev.to}，两端均不含当日。</div>`;
}

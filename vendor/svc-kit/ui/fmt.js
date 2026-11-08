// @ts-check
// fmt.js —— 展示格式化（镜像主仓库「ISO 存储、本地展示」：ISO 串只在这里转本地）

function pad2(/** @type {number} */ n) { return n < 10 ? '0' + n : '' + n; }

/** @param {unknown} s */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 千分位整数 @param {number} n */
export function fmtInt(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

/** 毫秒 → 人话时长 @param {number} ms */
export function fmtDuration(ms) {
  const n = Number(ms || 0);
  if (n < 60 * 1000) return Math.round(n / 1000) + ' s';
  if (n < 60 * 60 * 1000) return Math.round(n / 60000) + ' min';
  return (n / 3600000).toFixed(1) + ' h';
}

/** ISO（UTC）→ 本地 YYYY-MM-DD HH:mm；坏输入尽力展示不抛 @param {string} iso */
export function fmtLocalFromIso(iso) {
  if (iso == null || iso === '') return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 相对时间（"3 分钟前"）@param {string} iso */
export function fmtAgo(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.round(s) + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}

/** 0-1 → 百分比串 @param {number|null} v */
export function fmtPct(v) {
  return v == null ? '—' : (v * 100).toFixed(1) + '%';
}

/**
 * 「上次活跃」列：ISO → 相对时间；无记录显示 —。
 *
 * 无记录有两种可能且**从数据本身分不出来**：① 该用户只有心跳、从未实质使用；
 * ② 是升级到 v4 之前的历史行、还没跑 `npm run backfill`。所以只显示中性的 —，
 * 由表头 title 说明这两种可能，不臆断成「从未使用」。
 * @param {string|null} iso
 */
export function fmtLastAt(iso) {
  return iso ? fmtAgo(iso) : '—';
}

/**
 * 「沉默天数」列。silentDays 为 null（无记录）显示 —；0 显示「今天」。
 * @param {number|null} days @param {number} warnOver 超过此值给 ⚠（调用方传 2×range）
 */
export function fmtSilent(days, warnOver) {
  if (days == null) return { text: '—', cls: '' };
  if (days === 0) return { text: '今天', cls: '' };
  return { text: days + ' 天', cls: days > warnOver ? 'silent-warn' : '' };
}

/**
 * 环比（本期 vs 上期）→ { text, cls }。
 *
 * 两期任一 < 10 时改显**绝对差**而非百分比：长尾工作流从 1 涨到 3 就是 +200%，
 * 在表里比真正重要的 +18%（312→368）还刺眼——那是噪声不是信号。
 * 上期为 0 也走这一支，顺带避开除零。
 *
 * @param {number} cur 本期值
 * @param {number} prev 上期值
 * @param {(n:number)=>string} [fmt] 绝对差的格式化（时长列传 fmtDuration，缺省千分位整数）
 * @returns {{text:string, cls:string}} cls ∈ '' | 'delta-up' | 'delta-down'
 */
export function fmtDelta(cur, prev, fmt) {
  const c = Number(cur || 0), p = Number(prev || 0);
  if (c === 0 && p === 0) return { text: '—', cls: '' };
  const d = c - p;
  const cls = d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : '';
  if (c < 10 || p < 10) {
    const f = fmt || fmtInt;
    return { text: (d > 0 ? '+' : d < 0 ? '-' : '') + f(Math.abs(d)), cls };
  }
  return { text: (d > 0 ? '+' : '') + ((d / p) * 100).toFixed(0) + '%', cls };
}

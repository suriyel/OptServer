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

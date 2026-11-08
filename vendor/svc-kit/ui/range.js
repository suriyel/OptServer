// @ts-check
// range.js —— 顶栏统计范围（7/30/90 天）单一来源；localStorage 记忆用户偏好。
// 外壳页面提供 #range-select；被跨源挂载的模块读的是宿主页里同一个下拉框（同一 DOM）。
// 页面里没有该下拉框时按 30 天缺省（不抛——kit 模块可能在无顶栏的页面里被加载）。

const KEY = 'cancongOps.rangeDays';
const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('range-select'));

try {
  const saved = localStorage.getItem(KEY);
  if (sel && saved && ['7', '30', '90'].includes(saved)) sel.value = saved;
} catch (_) { /* 无存储 */ }

/** @returns {number} */
export function rangeDays() { return Number(sel && sel.value) || 30; }

/** @param {() => void} fn */
export function onRangeChange(fn) {
  if (!sel) return;
  sel.addEventListener('change', () => {
    try { localStorage.setItem(KEY, sel.value); } catch (_) { /* 无存储 */ }
    fn();
  });
}

/** 本地日 YYYY-MM-DD（与服务器 localDay 同口径） @param {Date} d */
export function localDayStr(d) {
  return d.getFullYear()
    + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}

/** 今天（本地日串）——图表标注「进行中」的末点判定用 */
export function todayLocal() { return localDayStr(new Date()); }

/**
 * 当前范围 → /v1/stats 查询参数；30 天时返回 undefined 走服务器缺省（保持缺省联动）
 * @returns {{from: string, to: string} | undefined}
 */
export function rangeParams() {
  const days = rangeDays();
  if (days === 30) return undefined;
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 24 * 3600 * 1000);
  return { from: localDayStr(from), to: localDayStr(to) };
}

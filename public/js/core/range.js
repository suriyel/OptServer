// @ts-check
// range.js —— 顶栏统计范围（7/30/90 天）单一来源；localStorage 记忆用户偏好

const KEY = 'cancongOps.rangeDays';
const sel = /** @type {HTMLSelectElement} */ (document.getElementById('range-select'));

const saved = localStorage.getItem(KEY);
if (saved && ['7', '30', '90'].includes(saved)) sel.value = saved;

/** @returns {number} */
export function rangeDays() { return Number(sel.value) || 30; }

/** @param {() => void} fn */
export function onRangeChange(fn) {
  sel.addEventListener('change', () => {
    localStorage.setItem(KEY, sel.value);
    fn();
  });
}

/**
 * 当前范围 → /v1/stats 查询参数；30 天时返回 undefined 走服务器缺省（保持缺省联动）
 * @returns {{from: string, to: string} | undefined}
 */
export function rangeParams() {
  const days = rangeDays();
  if (days === 30) return undefined;
  const f = (/** @type {Date} */ d) => d.getFullYear()
    + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 24 * 3600 * 1000);
  return { from: f(from), to: f(to) };
}

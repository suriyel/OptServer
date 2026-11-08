// @ts-check
// i18n.js —— 极薄文案表：t('a.b', {x}) 查表 + 具名插值（{x}）。界面目前只有中文（locales/zh.json），
// 但文案自第一天起都走这里：以后要英文只补一张表 + 一个切换（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §0 Q13）。
// 约定（__tests__/i18n.test.js 守门）：t() 首参必须是字面量（查表型写成「函数 + 字面量臂」）；key 形态 a.b(.c)*。
// 表里缺 key ⇒ 原样返回 key（显眼，不抛）。

/** @type {Record<string, string>} */
let table = {};

/** @param {Record<string, string>} tbl */
export function setLocale(tbl) { table = tbl || {}; }

/** @param {string} url */
export async function loadLocale(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('locale HTTP ' + res.status);
  setLocale(await res.json());
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 */
export function t(key, vars) {
  const s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

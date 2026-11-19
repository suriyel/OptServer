// @ts-check
// reqflow.js —— 「需求研发」页签：只给一个打开自进化网站「需求研发」页的链接（看板与它的登录分开，不再嵌它的页面；见 evolve.js）。

import { evolveOrigin, renderLink } from './evolve.js';

/** main.js 启动时问：本中心有没有自进化服务（需求研发跟它同一个服务；没有就隐藏页签） */
export async function hasReqflow() { return !!(await evolveOrigin()); }

/** @param {HTMLElement} el */
export function init(el) { renderLink(el, '需求研发看板', '#req/board'); }

export async function refresh() { /* 只是一个链接 */ }

export function navigate() { /* 没有子页 */ }

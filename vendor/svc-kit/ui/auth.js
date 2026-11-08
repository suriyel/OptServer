// @ts-check
// auth.js —— 认证/账号 API 瘦封装（走 api.js：非 ok 抛错，401 交 onUnauthorized；跨源挂载时同样指向 apiBase）

import { getStats, send } from './api.js';

export function me() { return getStats('/auth/me'); }
export function logout() { return send('POST', '/auth/logout', {}); }
export function listUsers() { return getStats('/auth/users'); }
/** @param {string} username @param {string} password */
export function createUser(username, password) { return send('POST', '/auth/users', { username, password }); }
/** @param {string} username */
export function deleteUser(username) { return send('DELETE', '/auth/users/' + encodeURIComponent(username)); }
/** @param {string} oldPassword @param {string} newPassword */
export function changePassword(oldPassword, newPassword) { return send('POST', '/auth/password', { oldPassword, newPassword }); }

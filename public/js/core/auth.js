// @ts-check
// auth.js —— 认证/账号 API 瘦封装（同 core/api.js 风格：非 ok 抛错，401 回登录页）

/**
 * @param {string} method
 * @param {string} path 以 / 开头的 /v1 下路径，如 '/auth/me'
 * @param {any} [body]
 * @returns {Promise<any>} 响应的 data 字段（无 data 时为 undefined）
 */
async function call(method, path, body) {
  /** @type {RequestInit} */
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/v1' + path, opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data.data;
}

export function me() { return call('GET', '/auth/me'); }
export function logout() { return call('POST', '/auth/logout', {}); }
export function listUsers() { return call('GET', '/auth/users'); }
export function createUser(username, password) { return call('POST', '/auth/users', { username, password }); }
export function deleteUser(username) { return call('DELETE', '/auth/users/' + encodeURIComponent(username)); }
export function changePassword(oldPassword, newPassword) { return call('POST', '/auth/password', { oldPassword, newPassword }); }

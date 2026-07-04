// @ts-check
// api.js —— /v1 查询封装：非 2xx / ok:false 一律抛 Error，由页面统一渲染错误框

/**
 * @param {string} p 以 / 开头的 /v1 下路径，如 '/stats/overview'
 * @param {Record<string, string>} [params]
 * @returns {Promise<any>} 响应的 data 字段
 */
export async function getStats(p, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch('/v1' + p + qs);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  if (!body || body.ok !== true) throw new Error((body && body.error) || 'api error');
  return body.data;
}

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
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); } // 会话过期→回登录
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  if (!body || body.ok !== true) throw new Error((body && body.error) || 'api error');
  return body.data;
}

/**
 * 代际守卫：并发的多次 refresh 只认**最后发起**的那次，丢弃先发后至的旧快照。
 *
 * 没有它就会出现「顶栏显示 7 天、表格渲染 90 天数据」——切档位时旧请求还在途，
 * 90 天查询比 7 天慢，落地顺序与发起顺序相反，后落地的旧结果把新结果覆盖掉。
 * 触发面比想象中大：60s 轮询与 `visibilitychange` 会和手动切档并发（版本发布页
 * 已因同一类竞态出过故障，见 RELEASE-NOTES v0.4.0 后的「代际守卫」）。
 *
 * 用法：`const g = guard.next()` → await → `if (guard.stale(g)) return;` **再**改模块状态。
 * 守卫必须挡在**赋值之前**，挡在渲染前是不够的——状态一旦被旧数据写脏，
 * 下一次纯本地重渲染（排序、展开）就会把脏数据画出来。
 */
export function makeGuard() {
  let gen = 0;
  return {
    next() { return ++gen; },
    stale(g) { return g !== gen; },
  };
}

// @ts-check
// download.js —— 触发浏览器下载 /v1/export/* CSV（后端已设 Content-Disposition: attachment）。
// 用隐藏 <a> 点击，不离开当前页面；内网无鉴权，直接走 URL 即可。

/**
 * @param {string} view 'blueprints' | 'users' | 'failures' | 'installs'
 * @param {{from: string, to: string} | undefined} [params] 日期范围；缺省(近30天)走服务端默认
 */
export function downloadCsv(view, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const a = document.createElement('a');
  a.href = '/v1/export/' + view + qs;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

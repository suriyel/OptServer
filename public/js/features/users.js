// @ts-check
// users.js —— 用户页：Top N 高频用户。metric 选择器（会话/run/token/时长/失败）→ 重查
// /v1/stats/users/top?metric=（服务器按 metric 排序取 Top N）。表格展示全指标。

import { getStats } from '../core/api.js';
import { escapeHtml, fmtInt, fmtDuration } from '../core/fmt.js';
import { rangeParams } from '../core/range.js';

// value 对应服务器 metric 白名单；label 用户可见
const METRICS = [
  { value: 'sessions', label: '会话数' },
  { value: 'runs', label: 'run 数' },
  { value: 'tokens', label: 'Token' },
  { value: 'sessionMs', label: '活跃时长' },
  { value: 'failures', label: '失败数' },
];

/** @type {HTMLElement} */ let root;
let metric = 'sessions';

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="panel">
      <h3>高频用户 Top 10</h3>
      <div style="margin-bottom:10px">
        排序指标：
        <select id="us-metric">
          ${METRICS.map((m) => `<option value="${m.value}">${m.label}</option>`).join('')}
        </select>
      </div>
      <div id="us-table"></div>
    </div>
    <div class="error-box" id="us-error"></div>`;
  el.querySelector('#us-metric').addEventListener('change', (e) => {
    metric = /** @type {HTMLSelectElement} */ (e.target).value;
    refresh();
  });
}

export async function refresh() {
  const errBox = root.querySelector('#us-error');
  errBox.textContent = '';
  try {
    const params = Object.assign({ metric, limit: '10' }, rangeParams());
    const d = await getStats('/stats/users/top', params);
    render(d.users);
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function render(users) {
  if (!users.length) { root.querySelector('#us-table').innerHTML = '<div class="empty">范围内无用户活动</div>'; return; }
  // 高亮当前排序列
  const mark = (m) => metric === m ? ' style="color:var(--amber)"' : '';
  const body = users.map((u, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td>${escapeHtml(u.user)}@${escapeHtml(u.host)}</td>
    <td class="num"${mark('sessions')}>${fmtInt(u.sessions)}</td>
    <td class="num"${mark('runs')}>${fmtInt(u.runs)}</td>
    <td class="num"${mark('tokens')}>${fmtInt(u.tokens)}</td>
    <td class="num"${mark('sessionMs')}>${fmtDuration(u.sessionMs)}</td>
    <td class="num"${mark('failures')}>${fmtInt(u.failures)}</td>
  </tr>`).join('');
  root.querySelector('#us-table').innerHTML = `<table><thead><tr>
      <th class="num">#</th><th>用户</th>
      <th class="num">会话数</th><th class="num">run 数</th><th class="num">Token</th>
      <th class="num">活跃时长</th><th class="num">失败数</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

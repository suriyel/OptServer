// @ts-check
// users.js —— 用户页：Top N 高频用户。ECharts 横向排名条形图（主视图）+ 明细表。
// metric 分段控件（会话/run/token/时长/失败）→ 重查 /v1/stats/users/top?metric=（服务器排序）。

import { getStats } from '../core/api.js';
import { escapeHtml, fmtInt, fmtDuration } from '../core/fmt.js';
import { rangeParams } from '../core/range.js';
import { makeChart, rankedBar, EC } from '../core/echarts.js';

const METRICS = [
  { value: 'sessions', label: '会话数', color: EC.amber, fmt: fmtInt },
  { value: 'runs', label: 'run 数', color: EC.cyan, fmt: fmtInt },
  { value: 'tokens', label: 'Token', color: EC.violet, fmt: fmtInt },
  { value: 'sessionMs', label: '活跃时长', color: EC.blue, fmt: fmtDuration },
  { value: 'failures', label: '失败数', color: EC.red, fmt: fmtInt },
];

/** @type {HTMLElement} */ let root;
/** @type {any} */ let chart;
let metric = 'sessions';

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>高频用户 Top 10</h3>
        <div class="metric-seg" id="us-seg">
          ${METRICS.map((m) => `<button data-m="${m.value}"${m.value === metric ? ' class="on"' : ''}>${m.label}</button>`).join('')}
        </div>
      </div>
      <div class="echart echart-tall" id="us-chart"></div>
    </div>
    <div class="panel"><h3>明细</h3><div id="us-table"></div></div>
    <div class="error-box" id="us-error"></div>`;
  chart = makeChart(/** @type {HTMLElement} */ (el.querySelector('#us-chart')));
  el.querySelector('#us-seg').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b || !b.dataset.m) return;
    metric = b.dataset.m;
    el.querySelectorAll('#us-seg button').forEach((x) => x.classList.toggle('on', /** @type {HTMLElement} */ (x).dataset.m === metric));
    refresh();
  });
}

export async function refresh() {
  const errBox = root.querySelector('#us-error');
  errBox.textContent = '';
  try {
    const params = Object.assign({ metric, limit: '10' }, rangeParams());
    const d = await getStats('/stats/users/top', params);
    renderChart(d.users);
    renderTable(d.users);
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function metricVal(u) {
  return metric === 'tokens' ? u.tokens
    : metric === 'runs' ? u.runs
    : metric === 'sessionMs' ? u.sessionMs
    : metric === 'failures' ? u.failures : u.sessions;
}

function renderChart(users) {
  const m = METRICS.find((x) => x.value === metric);
  // 服务器已按 metric 降序；条形图最大值置顶（rankedBar inverse）
  chart.set(rankedBar({
    categories: users.map((u) => u.user + '@' + u.host),
    values: users.map(metricVal),
    color: m.color,
    valueFmt: m.fmt,
  }));
}

function renderTable(users) {
  if (!users.length) { root.querySelector('#us-table').innerHTML = '<div class="empty">范围内无用户活动</div>'; return; }
  const mark = (col) => metric === col ? ' style="color:var(--amber)"' : '';
  const body = users.map((u, i) => `<tr>
    <td><span class="rank${i < 3 ? ' top' : ''}">${i + 1}</span></td>
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

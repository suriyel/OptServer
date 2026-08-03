// @ts-check
// users.js —— 用户页：Top N 高频用户。ECharts 横向排名条形图（主视图）+ 明细表（点行展开详情）。
// metric 分段控件（会话/run/token/时长/失败）→ 重查 /v1/stats/users/top?metric=（服务器排序）。
//
// 环比列跟在当前 metric 那一列后面（用户页由 metric 而非表头点击决定排序）。
// 展开详情画的也是当前 metric 的逐日曲线，与页面焦点保持一致。

import { getStats, makeGuard } from '../core/api.js';
import { escapeHtml, fmtInt, fmtDuration, fmtDelta } from '../core/fmt.js';
import { rangeParams, todayLocal } from '../core/range.js';
import { makeChart, rankedBar, timeLine, EC } from '../core/echarts.js';
import { downloadCsv } from '../core/download.js';
import { cmpGrid, mdLabel, rangeNote } from '../core/detail.js';

// value 同时是表列 key、排序 metric 与 cur/prev 字段名——三者同名是刻意的，省掉一层映射
const METRICS = [
  { value: 'sessions', label: '会话数', color: EC.amber, fmt: fmtInt },
  { value: 'runs', label: 'run 数', color: EC.cyan, fmt: fmtInt },
  { value: 'tokens', label: 'Token', color: EC.violet, fmt: fmtInt },
  { value: 'sessionMs', label: '活跃时长', color: EC.blue, fmt: fmtDuration },
  { value: 'failures', label: '失败数', color: EC.red, fmt: fmtInt },
];

const CMP_METRICS = METRICS.map((m) => ({ key: m.value, label: m.label, fmt: m.fmt }));

/** @type {HTMLElement} */ let root;
/** @type {any} */ let chart;
let metric = 'sessions';
/** @type {any[]} */ let users = [];
/** @type {any} */ let compare = null;
/** 服务器回的区间右端；等于今天时末点不完整，标题上要说明 @type {string|null} */
let rangeTo = null;
/** 当前展开行的身份键 JSON.stringify([user, host])（用户名里可能有 '@'，不能拿拼串当键） @type {string|null} */
let expandedKey = null;
/** @type {any} */ let detailChart = null;
/** @type {Map<string, any>} */ const seriesCache = new Map();
/** 列表请求的代际守卫（切档位/切 metric/轮询并发时丢弃先发后至的旧快照） */
const listGuard = makeGuard();

const idOf = (u, h) => JSON.stringify([u, h]);

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
    <div class="panel">
      <div class="panel-head">
        <h3>明细</h3>
        <button class="export-btn" id="us-export">导出 CSV</button>
      </div>
      <div id="us-table"></div>
    </div>
    <div class="error-box" id="us-error"></div>`;
  chart = makeChart(/** @type {HTMLElement} */ (el.querySelector('#us-chart')));
  el.querySelector('#us-seg').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b || !b.dataset.m) return;
    metric = b.dataset.m;
    el.querySelectorAll('#us-seg button').forEach((x) => x.classList.toggle('on', /** @type {HTMLElement} */ (x).dataset.m === metric));
    refresh();
  });
  el.querySelector('#us-table').addEventListener('click', (e) => {
    const tr = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('tr[data-k]'));
    if (!tr) return;
    expandedKey = expandedKey === tr.dataset.k ? null : tr.dataset.k;
    renderTable();
  });
  // 导出全部用户 + 全部指标列（后端忽略 metric，与 Top10 视图无关）
  el.querySelector('#us-export').addEventListener('click', () => downloadCsv('users', rangeParams()));
}

export async function refresh() {
  const errBox = root.querySelector('#us-error');
  errBox.textContent = '';
  const g = listGuard.next();
  try {
    const params = Object.assign({ metric, limit: '10' }, rangeParams());
    const d = await getStats('/stats/users/top', params);
    if (listGuard.stale(g)) return; // 有更新的一次在途/已落地，本次结果整个丢弃（守卫必须在赋值前）
    users = d.users;
    compare = d.compare || null;
    rangeTo = d.to;
    seriesCache.clear();
    if (expandedKey && !users.some((u) => idOf(u.user, u.host) === expandedKey)) expandedKey = null;
    renderChart();
    renderTable();
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function metricDef() { return METRICS.find((x) => x.value === metric) || METRICS[0]; }

function renderChart() {
  const m = metricDef();
  // 服务器已按 metric 降序；条形图最大值置顶（rankedBar inverse）
  chart.set(rankedBar({
    categories: users.map((u) => u.user + '@' + u.host),
    values: users.map((u) => u[metric] || 0),
    color: m.color,
    valueFmt: m.fmt,
  }));
}

function renderTable() {
  disposeDetail();
  if (!users.length) { root.querySelector('#us-table').innerHTML = '<div class="empty">范围内无用户活动</div>'; return; }
  const colCount = 2 + METRICS.length + (compare ? 1 : 0); // #、用户 + 指标列 + 可选环比列

  const head = '<th class="num">#</th><th>用户</th>' + METRICS.map((m) => {
    const on = m.value === metric ? ' style="color:var(--amber)"' : '';
    let h = `<th class="num"${on}>${m.label}</th>`;
    if (compare && m.value === metric) h += '<th class="num" title="本期 vs 上期，两端均不含当日">环比</th>';
    return h;
  }).join('');

  const body = users.map((u, i) => {
    const k = idOf(u.user, u.host);
    const open = expandedKey === k;
    const cells = METRICS.map((m) => {
      const on = m.value === metric ? ' style="color:var(--amber)"' : '';
      let td = `<td class="num"${on}>${m.fmt(u[m.value] || 0)}</td>`;
      if (compare && m.value === metric) {
        const d = fmtDelta(u.cur ? u.cur[m.value] : 0, u.prev ? u.prev[m.value] : 0, m.fmt);
        td += `<td class="num cmp-td ${d.cls}">${d.text}</td>`;
      }
      return td;
    }).join('');
    return `<tr class="row-x${open ? ' open' : ''}" data-k='${escapeHtml(k)}'>
        <td class="num"><span class="rank${i < 3 ? ' top' : ''}">${i + 1}</span></td>
        <td><span class="caret">${open ? '▾' : '▸'}</span>${escapeHtml(u.user)}@${escapeHtml(u.host)}</td>
        ${cells}
      </tr>` + (open ? detailRow(u, colCount) : '');
  }).join('');

  root.querySelector('#us-table').innerHTML =
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` + rangeNote(compare);
  if (expandedKey) mountDetail();
}

function detailRow(u, colCount) {
  // 「当日不完整」写在标题行而非图内：图内标签在窄格上必被裁掉（见 core/echarts.js dimLast 注释）
  const partial = rangeTo === todayLocal();
  return `<tr class="detail-row"><td colspan="${colCount}"><div class="detail">
      <div class="detail-title">${escapeHtml(u.user)}@${escapeHtml(u.host)} · 逐日${escapeHtml(metricDef().label)}${
        partial ? '<span class="detail-note">末点为当日，数据不完整</span>' : ''}</div>
      <div class="echart detail-chart" id="us-detail-chart"></div>
      ${compare ? '<div class="detail-title">本期 vs 上期</div>' + cmpGrid(u.cur, u.prev, CMP_METRICS) : ''}
    </div></td></tr>`;
}

function disposeDetail() {
  if (detailChart) { detailChart.dispose(); detailChart = null; }
}

function loadingOption(text, color) {
  return { title: { text, left: 'center', top: 'middle',
    textStyle: { color: color || '#565d69', fontFamily: '"IBM Plex Mono",monospace', fontSize: 13 } } };
}

// 序列接口回的是原始列；runs/tokens 是派生量，与列表口径保持一致地在前端合成
function seriesValue(x) {
  if (metric === 'runs') return x.runsDone + x.runsFailed + x.runsHalted;
  if (metric === 'tokens') return x.inTokens + x.outTokens;
  return x[metric] || 0;
}

async function mountDetail() {
  const el = /** @type {HTMLElement} */ (root.querySelector('#us-detail-chart'));
  if (!el) return;
  // 捕获**本次**实例：切档位/切 metric 会 dispose 旧图重挂新图，光判 expandedKey 不变是不够的
  // （同一行、不同 range 的两次挂载 key 相同），必须比实例身份才能挡住旧序列画进新图
  const inst = makeChart(el);
  detailChart = inst;
  inst.set(loadingOption('加载中…'));
  const key = expandedKey;
  try {
    let d = seriesCache.get(key);
    if (!d) {
      const [user, host] = JSON.parse(key);
      d = await getStats('/stats/users/series', Object.assign({ user, host }, rangeParams()));
      seriesCache.set(key, d);
    }
    if (expandedKey !== key || detailChart !== inst) return; // 期间已折叠/换行/换档，丢弃这次结果
    const m = metricDef();
    const days = d.days;
    inst.set(timeLine({
      categories: days.map((x) => mdLabel(x.day)),
      partialLast: days.length > 0 && days[days.length - 1].day === todayLocal(),
      series: [{ name: m.label, color: m.color, values: days.map(seriesValue), area: true, fmt: m.fmt }],
    }));
  } catch (e) {
    if (detailChart === inst) inst.set(loadingOption('序列加载失败：' + /** @type {Error} */ (e).message, '#e8615f'));
  }
}

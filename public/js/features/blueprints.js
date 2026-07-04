// @ts-check
// blueprints.js —— 工作流页（对外术语；内部 blueprintId）：ECharts 图表（主视图，指标可切换）
// + 明细表（表头点击排序）。数据来自 /v1/stats/blueprints。

import { getStats } from '../core/api.js';
import { escapeHtml, fmtInt, fmtDuration } from '../core/fmt.js';
import { rangeParams } from '../core/range.js';
import { makeChart, stackedBar, rankedBar, EC } from '../core/echarts.js';

const CHART_TOP = 12; // 图表最多展示前 N 个工作流（表格展示全部）

const CHART_METRICS = [
  { value: 'outcome', label: '运行终态' },
  { value: 'tokens', label: 'Token' },
  { value: 'interruptions', label: '中断' },
];

const COLUMNS = [
  { key: 'blueprintId', label: '工作流', num: false },
  { key: 'runs', label: '运行', num: true },
  { key: 'runsDone', label: '成功', num: true },
  { key: 'runsFailed', label: '失败run', num: true },
  { key: 'runsHalted', label: '中止', num: true },
  { key: 'failures', label: '失败事件', num: true },
  { key: 'activeMs', label: '活跃时长', num: true, fmt: fmtDuration },
  { key: 'interruptions', label: '中断', num: true },
  { key: 'tokens', label: 'Token', num: true },
];

/** @type {HTMLElement} */ let root;
/** @type {any} */ let chart;
/** @type {any[]} */ let rows = [];
let chartMetric = 'outcome';
let sortKey = 'runs';
let sortDesc = true;

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>工作流概览</h3>
        <div class="metric-seg" id="bp-seg">
          ${CHART_METRICS.map((m) => `<button data-m="${m.value}"${m.value === chartMetric ? ' class="on"' : ''}>${m.label}</button>`).join('')}
        </div>
      </div>
      <div class="echart echart-tall" id="bp-chart"></div>
    </div>
    <div class="panel"><h3>明细</h3><div id="bp-table"></div></div>
    <div class="error-box" id="bp-error"></div>`;
  chart = makeChart(/** @type {HTMLElement} */ (el.querySelector('#bp-chart')));
  el.querySelector('#bp-seg').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b || !b.dataset.m) return;
    chartMetric = b.dataset.m;
    el.querySelectorAll('#bp-seg button').forEach((x) => x.classList.toggle('on', /** @type {HTMLElement} */ (x).dataset.m === chartMetric));
    renderChart();
  });
  el.querySelector('#bp-table').addEventListener('click', (e) => {
    const th = /** @type {HTMLElement} */ (e.target).closest('th');
    if (!th || !th.dataset.key) return;
    if (sortKey === th.dataset.key) sortDesc = !sortDesc;
    else { sortKey = th.dataset.key; sortDesc = true; }
    renderTable();
  });
}

export async function refresh() {
  const errBox = root.querySelector('#bp-error');
  errBox.textContent = '';
  try {
    const d = await getStats('/stats/blueprints', rangeParams());
    rows = d.blueprints;
    renderChart();
    renderTable();
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function renderChart() {
  // 服务器按 runs 降序返回；取前 N，图表内反转使最大值在顶部
  const top = rows.slice(0, CHART_TOP);
  const cats = top.map((r) => r.blueprintId);
  if (!cats.length) { chart.set({ title: { text: '范围内无工作流运行', left: 'center', top: 'middle',
    textStyle: { color: '#565d69', fontFamily: '"IBM Plex Mono",monospace', fontSize: 13 } } }); return; }

  if (chartMetric === 'outcome') {
    chart.set(stackedBar({ categories: cats, valueFmt: fmtInt, series: [
      { name: '成功', color: EC.green, values: top.map((r) => r.runsDone) },
      { name: '失败', color: EC.red, values: top.map((r) => r.runsFailed) },
      { name: '中止', color: EC.orange, values: top.map((r) => r.runsHalted) },
    ] }));
  } else if (chartMetric === 'tokens') {
    chart.set(stackedBar({ categories: cats, valueFmt: fmtInt, series: [
      { name: '输入', color: EC.blue, values: top.map((r) => r.inTokens) },
      { name: '输出', color: EC.amber, values: top.map((r) => r.outTokens) },
    ] }));
  } else {
    chart.set(rankedBar({ categories: cats, values: top.map((r) => r.interruptions), color: EC.cyan, valueFmt: fmtInt }));
  }
}

function renderTable() {
  const sorted = rows.slice().sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv : String(av || '').localeCompare(String(bv || ''));
    return sortDesc ? -cmp : cmp;
  });
  const head = COLUMNS.map((c) => `<th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}">${c.label}`
    + (sortKey === c.key ? `<span class="arrow">${sortDesc ? '▼' : '▲'}</span>` : '') + '</th>').join('');
  const bodyRows = sorted.map((r) => '<tr>' + COLUMNS.map((c) => {
    if (!c.num) return `<td>${escapeHtml(r[c.key])}</td>`;
    return `<td class="num">${c.fmt ? c.fmt(r[c.key]) : fmtInt(r[c.key])}</td>`;
  }).join('') + '</tr>').join('');
  root.querySelector('#bp-table').innerHTML = sorted.length
    ? `<table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`
    : '<div class="empty">范围内无工作流运行</div>';
}

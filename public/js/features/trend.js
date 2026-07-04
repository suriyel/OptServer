// @ts-check
// trend.js —— 趋势页：双模式（按日期 / 实时）。全部走 ECharts。
// · 按日期：沿用全局 range（7/30/90），x=日(M/D)。
// · 实时：近 24h、1min 分桶（前端补零完整分钟轴、x=本地 HH:MM），60s 全局刷新拉新桶。

import { getStats } from '../core/api.js';
import { fmtDuration, fmtInt } from '../core/fmt.js';
import { makeChart, timeLine, timeBars, EC } from '../core/echarts.js';
import { rangeParams } from '../core/range.js';

const RT_WINDOW = 1440; // 实时窗口分钟数（24h）
const MODE_KEY = 'cancongOps.trendMode';

const MODES = [
  { value: 'daily', label: '按日期' },
  { value: 'realtime', label: '实时' },
];

/** @type {HTMLElement} */ let root;
/** @type {Record<string, any>} */ const charts = {};
let mode = 'daily';

export function init(el) {
  root = el;
  const saved = localStorage.getItem(MODE_KEY);
  if (saved === 'daily' || saved === 'realtime') mode = saved;
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3 id="tr-heading">活动趋势</h3>
        <div class="metric-seg" id="tr-mode">
          ${MODES.map((m) => `<button data-m="${m.value}"${m.value === mode ? ' class="on"' : ''}>${m.label}</button>`).join('')}
        </div>
      </div>
      <div id="tr-hint" class="muted"></div>
    </div>
    <div class="panel"><h3 id="tr-t1"></h3><div class="echart" id="tr-c1"></div></div>
    <div class="panel"><h3 id="tr-t2"></h3><div class="echart" id="tr-c2"></div></div>
    <div class="panel"><h3 id="tr-t3"></h3><div class="echart" id="tr-c3"></div></div>
    <div class="panel"><h3 id="tr-t4"></h3><div class="echart" id="tr-c4"></div></div>
    <div class="error-box" id="tr-error"></div>`;
  for (const id of ['c1', 'c2', 'c3', 'c4']) charts[id] = makeChart(/** @type {HTMLElement} */ (el.querySelector('#tr-' + id)));
  el.querySelector('#tr-mode').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b || !b.dataset.m || b.dataset.m === mode) return;
    mode = b.dataset.m;
    localStorage.setItem(MODE_KEY, mode);
    el.querySelectorAll('#tr-mode button').forEach((x) => x.classList.toggle('on', /** @type {HTMLElement} */ (x).dataset.m === mode));
    refresh();
  });
}

export async function refresh() {
  const errBox = root.querySelector('#tr-error');
  errBox.textContent = '';
  try {
    if (mode === 'realtime') await refreshRealtime();
    else await refreshDaily();
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function setTitles(t) {
  root.querySelector('#tr-t1').textContent = t[0];
  root.querySelector('#tr-t2').textContent = t[1];
  root.querySelector('#tr-t3').textContent = t[2];
  root.querySelector('#tr-t4').textContent = t[3];
}

// ---- 按日期 ----
async function refreshDaily() {
  const params = rangeParams();
  const [dau, runs] = await Promise.all([
    getStats('/stats/dau', params),
    getStats('/stats/runs', params),
  ]);
  const x = dau.days.map((d) => mdLabel(d.day));
  root.querySelector('#tr-heading').textContent = '活动趋势';
  root.querySelector('#tr-hint').textContent = '';
  setTitles(['活跃用户（DAU / WAU）', '会话数与总时长', 'Token 消耗（输入 / 输出）', '工作流 run 终态分布']);

  charts.c1.set(timeLine({ categories: x, series: [
    { name: 'DAU', color: EC.amber, values: dau.days.map((d) => d.dau) },
    { name: 'WAU', color: EC.cyan, values: dau.days.map((d) => d.wau) },
  ] }));
  charts.c2.set(timeLine({ categories: x, series: [
    { name: '会话数', color: EC.green, values: dau.days.map((d) => d.sessions) },
    { name: '总时长', color: EC.violet, axis: 2, values: dau.days.map((d) => d.sessionMs), fmt: fmtDuration },
  ] }));
  charts.c3.set(timeLine({ categories: x, series: [
    { name: '输入 Token', color: EC.blue, values: dau.days.map((d) => d.inTokens || 0), area: true },
    { name: '输出 Token', color: EC.amber, values: dau.days.map((d) => d.outTokens || 0), area: true },
  ] }));
  charts.c4.set(timeBars({ categories: runs.days.map((d) => mdLabel(d.day)), series: [
    { name: '成功', color: EC.green, values: runs.days.map((d) => d.done) },
    { name: '失败', color: EC.red, values: runs.days.map((d) => d.failed) },
    { name: '中止', color: EC.orange, values: runs.days.map((d) => d.halted) },
  ] }));
}

// ---- 实时（近 24h / 1min）----
async function refreshRealtime() {
  const d = await getStats('/stats/realtime', { window: String(RT_WINDOW) });
  // 建完整分钟轴（补零）：从 now-window 到 now，key=UTC 分钟串，label=本地 HH:MM
  const nowMs = new Date(d.now).getTime();
  const startMs = nowMs - d.window * 60000;
  const map = new Map(d.buckets.map((b) => [b.min, b]));
  const x = [], get = {};
  const fields = ['events', 'sessions', 'runsDone', 'runsFailed', 'runsHalted', 'failures', 'tokens', 'activeUsers'];
  for (const f of fields) get[f] = [];
  for (let ms = Math.ceil(startMs / 60000) * 60000; ms <= nowMs; ms += 60000) {
    const dt = new Date(ms);
    const b = map.get(dt.toISOString().slice(0, 16));
    x.push(hhmm(dt));
    for (const f of fields) get[f].push(b ? b[f] : 0);
  }
  root.querySelector('#tr-heading').textContent = '实时活动（近 24 小时 · 每分钟）';
  root.querySelector('#tr-hint').textContent = '数据来自 events 近窗口直查；「活跃人数」= 每分钟有事件的去重用户（非在线数）。';
  setTitles(['事件总量 / 分钟', '工作流 run 终态 / 分钟', '活跃人数 与 会话数 / 分钟', 'Token 消耗 / 分钟']);

  charts.c1.set(timeLine({ categories: x, zoom: true, series: [
    { name: '事件', color: EC.amber, values: get.events, area: true },
  ] }));
  charts.c2.set(timeBars({ categories: x, zoom: true, series: [
    { name: '成功', color: EC.green, values: get.runsDone },
    { name: '失败', color: EC.red, values: get.runsFailed },
    { name: '中止', color: EC.orange, values: get.runsHalted },
  ] }));
  charts.c3.set(timeLine({ categories: x, zoom: true, series: [
    { name: '活跃人数', color: EC.cyan, values: get.activeUsers },
    { name: '会话数', color: EC.green, values: get.sessions },
  ] }));
  charts.c4.set(timeLine({ categories: x, zoom: true, series: [
    { name: 'Token', color: EC.violet, values: get.tokens, area: true, fmt: fmtInt },
  ] }));
}

function mdLabel(day) { const [, m, d] = day.split('-'); return Number(m) + '/' + Number(d); }
function hhmm(dt) { return String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'); }

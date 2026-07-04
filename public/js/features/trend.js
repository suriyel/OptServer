// @ts-check
// trend.js —— 趋势页：DAU/WAU 折线、会话数+时长双轴折线、run 终态堆叠柱（uPlot）

import { getStats } from '../core/api.js';
import { fmtDuration } from '../core/fmt.js';
import { lineChart, stackedBars, COLORS } from '../core/charts.js';
import { rangeParams } from '../core/range.js';

/** @type {HTMLElement} */ let root;
/** @type {any[]} */ let charts = [];

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="panel"><h3>活跃用户（DAU / WAU）</h3><div class="chart" id="tr-dau"></div></div>
    <div class="panel"><h3>会话数与总时长</h3><div class="chart" id="tr-sessions"></div></div>
    <div class="panel"><h3>Token 消耗（输入 / 输出）</h3><div class="chart" id="tr-tokens"></div></div>
    <div class="panel"><h3>工作流 run 终态分布</h3><div class="chart" id="tr-runs"></div></div>
    <div class="error-box" id="tr-error"></div>`;
}

export async function refresh() {
  const errBox = root.querySelector('#tr-error');
  errBox.textContent = '';
  try {
    const params = rangeParams();
    const [dau, runs] = await Promise.all([
      getStats('/stats/dau', params),
      getStats('/stats/runs', params),
    ]);
    // 每次重建图（数据量小、代码简单胜过增量 setData）；先断开旧 ResizeObserver
    for (const u of charts) { try { u._ro.disconnect(); u.destroy(); } catch (_) { /* 已销毁 */ } }
    charts = [];

    const dayLabels = dau.days.map((x) => x.day);
    charts.push(lineChart(root.querySelector('#tr-dau'), dayLabels, [
      { label: 'DAU', color: COLORS.amber, values: dau.days.map((x) => x.dau) },
      { label: 'WAU', color: COLORS.blue, values: dau.days.map((x) => x.wau) },
    ]));
    charts.push(lineChart(root.querySelector('#tr-sessions'), dayLabels, [
      { label: '会话数', color: COLORS.green, values: dau.days.map((x) => x.sessions) },
      { label: '总时长', color: COLORS.purple, axis: 2, values: dau.days.map((x) => x.sessionMs), fmt: fmtDuration },
    ]));
    charts.push(lineChart(root.querySelector('#tr-tokens'), dayLabels, [
      { label: '输入 Token', color: COLORS.blue, values: dau.days.map((x) => x.inTokens || 0) },
      { label: '输出 Token', color: COLORS.amber, values: dau.days.map((x) => x.outTokens || 0) },
    ]));
    charts.push(stackedBars(root.querySelector('#tr-runs'), runs.days.map((x) => x.day), [
      { label: 'done', color: COLORS.green, values: runs.days.map((x) => x.done) },
      { label: 'failed', color: COLORS.red, values: runs.days.map((x) => x.failed) },
      { label: 'halted', color: COLORS.orange, values: runs.days.map((x) => x.halted) },
    ]));
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}


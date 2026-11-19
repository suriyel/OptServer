// @ts-check
// echarts.js —— ECharts 唯一收口（vendored 库挂 window.echarts，ESM 侧只从这里访问）。
// 统一仪表盘暗色主题（等宽数字、细网格、amber→cyan 信号色），并提供排名条形 / 堆叠条形构建器。

const echarts = /** @type {any} */ (window)['echarts'];

export const EC = {
  amber: '#8a5000', cyan: '#0b655e', green: '#27693f', red: '#b3362f',
  orange: '#974404', blue: '#2c5fa8', violet: '#6d4bb5', muted: '#6a6051',
};

const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const AXIS = '#d9cfbd';
const TEXT = '#51483b';
const DIM = '#63594b';

// 竖向渐变填充（顶亮底暗），营造"发光条"质感
function grad(hex) {
  return {
    type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
    colorStops: [{ offset: 0, color: hex + '55' }, { offset: 1, color: hex }],
  };
}

function baseOption() {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: MONO, color: TEXT },
    grid: { left: 8, right: 24, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(253,251,246,0.97)', borderColor: AXIS, borderWidth: 1,
      textStyle: { color: TEXT, fontFamily: MONO, fontSize: 12 },
      extraCssText: 'backdrop-filter:blur(6px);border-radius:8px;',
    },
    legend: {
      textStyle: { color: DIM, fontFamily: MONO, fontSize: 11 },
      itemWidth: 10, itemHeight: 10, top: 0, right: 8,
    },
  };
}

const CAT_AXIS = {
  type: 'category',
  axisLine: { show: false }, axisTick: { show: false },
  axisLabel: { color: TEXT, fontFamily: MONO, fontSize: 12 },
};
const VAL_AXIS = {
  type: 'value',
  splitLine: { lineStyle: { color: AXIS, type: 'dashed' } },
  axisLabel: { color: DIM, fontFamily: MONO, fontSize: 11 },
};

/**
 * 起一个受管 ECharts 实例（自适应容器宽度；dispose 幂等）。
 * @param {HTMLElement} el
 */
export function makeChart(el) {
  let inst = echarts.getInstanceByDom(el) || echarts.init(el, null, { renderer: 'canvas' });
  const ro = new ResizeObserver(() => { if (el.clientWidth > 0) inst.resize(); });
  ro.observe(el);
  return {
    set(opt) { inst.setOption(opt, true); },
    dispose() { try { ro.disconnect(); inst.dispose(); } catch (_) { /* 已释放 */ } },
    inst,
  };
}

/**
 * 横向排名条形（Top N）。数据按传入顺序，最大值置顶。
 * @param {{ categories:string[], values:number[], color?:string, valueFmt?:(v:number)=>string }} d
 */
export function rankedBar(d) {
  const color = d.color || EC.amber;
  const fmt = d.valueFmt || ((v) => String(v));
  return Object.assign(baseOption(), {
    tooltip: Object.assign(baseOption().tooltip, { formatter: (p) => {
      const a = p[0]; return a.name + '<br/><b style="color:' + color + '">' + fmt(a.value) + '</b>';
    } }),
    grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
    xAxis: Object.assign({}, VAL_AXIS, { axisLabel: { show: false }, splitLine: { show: false } }),
    yAxis: Object.assign({}, CAT_AXIS, { inverse: true, data: d.categories }),
    series: [{
      type: 'bar', data: d.values, barWidth: '62%',
      itemStyle: { color: grad(color), borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: TEXT, fontFamily: MONO, fontSize: 11,
        formatter: (p) => fmt(p.value) },
      emphasis: { itemStyle: { color: color } },
      animationDelay: (i) => i * 40,
    }],
    animationEasing: 'cubicOut', animationDuration: 500,
  });
}

/**
 * 横向堆叠条形（多分量）。categories 为纵轴项，series 为堆叠分量。
 * @param {{ categories:string[], series:{name:string,color:string,values:number[]}[], valueFmt?:(v:number)=>string }} d
 */
export function stackedBar(d) {
  const fmt = d.valueFmt || ((v) => String(v));
  return Object.assign(baseOption(), {
    tooltip: Object.assign(baseOption().tooltip, { valueFormatter: fmt }),
    grid: { left: 8, right: 24, top: 28, bottom: 8, containLabel: true },
    xAxis: VAL_AXIS,
    yAxis: Object.assign({}, CAT_AXIS, { inverse: true, data: d.categories }),
    series: d.series.map((s, si) => ({
      name: s.name, type: 'bar', stack: 'total', data: s.values,
      barWidth: '62%',
      itemStyle: { color: s.color,
        borderRadius: si === d.series.length - 1 ? [0, 4, 4, 0] : 0 },
      emphasis: { focus: 'series' },
      animationDelay: (i) => i * 30,
    })),
    animationEasing: 'cubicOut', animationDuration: 500,
  });
}

// 周一置顶（周日排最后）：工作日连成一片，周末在底部自成一块，比 0=周日 起头好读
const WEEKDAY_ROWS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const weekdayRow = (wd) => (wd + 6) % 7; // 服务端 0=周日 → 行号

/**
 * 24×7 作息热力图。cells: [{ weekday(0=周日), hour(0-23), value }]
 * 空格子不传即可——这里会补 0，让"没人用的时段"显示为底色而不是空洞。
 * @param {{ cells:any[], valueFmt?:(v:number)=>string }} d
 */
export function heatmap(d) {
  const byKey = new Map(d.cells.map((c) => [weekdayRow(c.weekday) * 24 + c.hour, c.value]));
  const data = [];
  let max = 0;
  for (let row = 0; row < 7; row++) {
    for (let h = 0; h < 24; h++) {
      const v = byKey.get(row * 24 + h) || 0;
      if (v > max) max = v;
      data.push([h, row, v]);
    }
  }
  const fmt = d.valueFmt || ((v) => String(v));
  return Object.assign(baseOption(), {
    tooltip: Object.assign(baseOption().tooltip, {
      trigger: 'item', axisPointer: { type: 'none' },
      formatter: (p) => `${WEEKDAY_ROWS[p.value[1]]} ${String(p.value[0]).padStart(2, '0')}:00`
        + `<br/><b style="color:${EC.amber}">${fmt(p.value[2])}</b>`,
    }),
    grid: { left: 8, right: 16, top: 8, bottom: 46, containLabel: true },
    xAxis: Object.assign({}, CAT_AXIS, {
      data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
      splitArea: { show: false },
      axisLabel: { color: DIM, fontFamily: MONO, fontSize: 10, interval: 1 },
    }),
    yAxis: Object.assign({}, CAT_AXIS, { data: WEEKDAY_ROWS, inverse: true,
      axisLabel: { color: DIM, fontFamily: MONO, fontSize: 11 } }),
    // max=0（窗口内一条数据都没有）时给个 1，避免 visualMap 退化成 NaN 区间
    visualMap: {
      min: 0, max: max || 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 4,
      itemWidth: 11, itemHeight: 90,
      textStyle: { color: DIM, fontFamily: MONO, fontSize: 10 },
      // 从"接近底色"渐到 amber：零值几乎隐形，热点自己跳出来
      inRange: { color: ['#f1ebdf', '#ead9b5', '#dcb86a', '#c08a1e', '#734300'] },
    },
    series: [{
      type: 'heatmap', data,
      itemStyle: { borderColor: '#fdfbf6', borderWidth: 1 },
      emphasis: { itemStyle: { borderColor: EC.amber, borderWidth: 1 } },
      progressive: 0,
    }],
    animationDuration: 400,
  });
}

// x=时间标签的公共骨架（趋势日视图与实时视图共用）。zoom 时挂 dataZoom（内滚+底部滑条）。
function timeBase(categories, zoom) {
  const o = Object.assign(baseOption(), {
    grid: { left: 8, right: 20, top: 30, bottom: zoom ? 44 : 8, containLabel: true },
    xAxis: Object.assign({}, CAT_AXIS, {
      data: categories, boundaryGap: false,
      axisLabel: { color: DIM, fontFamily: MONO, fontSize: 11, hideOverlap: true },
    }),
    yAxis: VAL_AXIS,
  });
  if (zoom) {
    o.grid.top = 30;
    o.dataZoom = [
      { type: 'inside', throttle: 50 },
      { type: 'slider', height: 16, bottom: 8, borderColor: AXIS,
        fillerColor: 'rgba(138,80,0,0.12)', handleStyle: { color: '#8a5000' },
        dataBackground: { lineStyle: { color: AXIS }, areaStyle: { color: '#efe8da' } },
        textStyle: { color: DIM, fontFamily: MONO, fontSize: 10 } },
    ];
  }
  return o;
}

// 竖向面积渐变（顶亮底透），实时脉冲线用
function areaGrad(hex) {
  return { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [{ offset: 0, color: hex + '44' }, { offset: 1, color: hex + '02' }] };
}

// 末点「进行中」：区间末尾是今天时，那一天只过了一半，曲线必然往下掉。
// 不标出来会被当成真的在崩——把末点压暗以示未完成。
//
// 文字说明刻意放在**图外**（调用方的标题行）：一格类目只有 30~40px 宽，
// 图内 markArea 的标签在任何窄图/长区间下都会溢出被 grid 裁掉，靠不住。
function dimLast(values) {
  if (!values.length) return values;
  const out = values.slice();
  out[out.length - 1] = { value: out[out.length - 1], itemStyle: { opacity: 0.4 } };
  return out;
}

/**
 * 多序列折线（x=时间标签）。series: [{ name, color, values, axis?:2, fmt?, area? }]
 * @param {{ categories:string[], series:any[], zoom?:boolean, partialLast?:boolean }} d
 */
export function timeLine(d) {
  const o = timeBase(d.categories, d.zoom);
  const dual = d.series.some((s) => s.axis === 2);
  o.tooltip = Object.assign(baseOption().tooltip, { trigger: 'axis' });
  if (dual) {
    const right = d.series.find((s) => s.axis === 2);
    o.yAxis = [VAL_AXIS, Object.assign({}, VAL_AXIS, { splitLine: { show: false },
      axisLabel: { color: DIM, fontFamily: MONO, fontSize: 11,
        formatter: right && right.fmt ? (v) => right.fmt(v) : undefined } })];
  }
  o.series = d.series.map((s) => ({
    name: s.name, type: 'line', data: d.partialLast ? dimLast(s.values) : s.values,
    yAxisIndex: s.axis === 2 ? 1 : 0,
    showSymbol: false, smooth: 0.2, sampling: 'lttb',
    lineStyle: { color: s.color, width: 2 }, itemStyle: { color: s.color },
    areaStyle: s.area ? { color: areaGrad(s.color) } : undefined,
    emphasis: { focus: 'series' },
    tooltip: s.fmt ? { valueFormatter: s.fmt } : undefined,
  }));
  return o;
}

/**
 * 纵向堆叠柱（x=时间标签，run 终态）。series: [{ name, color, values }]
 * @param {{ categories:string[], series:any[], zoom?:boolean, partialLast?:boolean }} d
 */
export function timeBars(d) {
  const o = timeBase(d.categories, d.zoom);
  o.tooltip = Object.assign(baseOption().tooltip, { trigger: 'axis' });
  o.series = d.series.map((s) => ({
    name: s.name, type: 'bar', stack: 'total',
    data: d.partialLast ? dimLast(s.values) : s.values,
    itemStyle: { color: s.color }, emphasis: { focus: 'series' },
  }));
  return o;
}

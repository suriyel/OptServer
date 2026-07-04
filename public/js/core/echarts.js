// @ts-check
// echarts.js —— ECharts 唯一收口（vendored 库挂 window.echarts，ESM 侧只从这里访问）。
// 统一仪表盘暗色主题（等宽数字、细网格、amber→cyan 信号色），并提供排名条形 / 堆叠条形构建器。

const echarts = /** @type {any} */ (window)['echarts'];

export const EC = {
  amber: '#f0a830', cyan: '#38d6c4', green: '#54c08a', red: '#e8615f',
  orange: '#ec8a3c', blue: '#6aa6e0', violet: '#a888e6', muted: '#8b93a1',
};

const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const AXIS = '#2a2f38';
const TEXT = '#c9cdd4';
const DIM = '#6b7280';

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
      backgroundColor: 'rgba(20,23,30,0.96)', borderColor: AXIS, borderWidth: 1,
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

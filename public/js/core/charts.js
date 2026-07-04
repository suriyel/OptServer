// @ts-check
// charts.js —— uPlot 唯一收口（vendored 库挂 window.uPlot，ESM 侧只从这里访问）。
// 暗色主题、ResizeObserver 自适应、day 串 x 轴、堆叠柱用「累计值大先画、小后画盖上去」实现。

const uPlot = /** @type {any} */ (window)['uPlot'];

export const COLORS = {
  amber: '#e8a33d', green: '#4caf7d', red: '#e05c5c',
  orange: '#e8883d', blue: '#5b9dd9', purple: '#9d7be0', muted: '#8b93a1',
};

const AXIS_STYLE = {
  stroke: '#8b93a1',
  grid: { stroke: '#2e333c', width: 1 },
  ticks: { stroke: '#2e333c', width: 1 },
};

/** day 'YYYY-MM-DD' → 本地零点 unix 秒 @param {string} day */
export function dayToTs(day) {
  return new Date(day + 'T00:00:00').getTime() / 1000;
}

function baseOpts(el, extra) {
  const w = el.getBoundingClientRect().width || 560;
  return Object.assign({
    width: Math.max(280, Math.floor(w)),
    height: 240,
    cursor: { points: { size: 6 } },
    axes: [
      Object.assign({}, AXIS_STYLE, {
        values: (/** @type {any} */ u, /** @type {number[]} */ ts) =>
          ts.map((t) => {
            const d = new Date(t * 1000);
            return (d.getMonth() + 1) + '/' + d.getDate();
          }),
      }),
      Object.assign({}, AXIS_STYLE),
    ],
  }, extra || {});
}

/**
 * 折线图。series: [{ label, color, values:number[], axis?:2, fmt?:(v)=>string }]
 * @param {HTMLElement} el @param {string[]} days
 */
export function lineChart(el, days, series, opts) {
  const o = baseOpts(el, opts);
  o.series = [
    { label: '日期', value: (/** @type {any} */ u, /** @type {number} */ t) => t == null ? '' : new Date(t * 1000).toLocaleDateString() },
    ...series.map((s) => ({
      label: s.label,
      stroke: s.color,
      width: 2,
      scale: s.axis === 2 ? 'y2' : 'y',
      points: { show: days.length <= 45 },
      value: (/** @type {any} */ u, /** @type {number} */ v) => v == null ? '—' : (s.fmt ? s.fmt(v) : String(v)),
    })),
  ];
  if (series.some((s) => s.axis === 2)) {
    o.axes.push(Object.assign({}, AXIS_STYLE, {
      scale: 'y2', side: 1,
      values: (/** @type {any} */ u, /** @type {number[]} */ vs) => vs.map(series.find((s) => s.axis === 2).fmt || String),
    }));
    o.scales = { y2: { range: (/** @type {any} */ u, /** @type {number} */ min, /** @type {number} */ max) => [0, max * 1.1 || 1] } };
  }
  const data = [days.map(dayToTs), ...series.map((s) => s.values)];
  return mount(el, o, data);
}

/**
 * 堆叠柱（run 终态）：传原始分量，内部做累计；大值先画、小值后画盖上去形成分段。
 * parts: [{ label, color, values }]（自下而上的堆叠次序）
 * @param {HTMLElement} el @param {string[]} days
 */
export function stackedBars(el, days, parts, opts) {
  const n = days.length;
  // 自下而上累计：cum[k] = parts[0..k] 之和
  const cums = parts.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < parts.length; k++) {
      acc += Number(parts[k].values[i] || 0);
      cums[k][i] = acc;
    }
  }
  const barsPath = uPlot.paths.bars({ size: [0.6, 100] });
  const o = baseOpts(el, opts);
  // 画序：累计最高的（含顶层分量）先画，最底层分量的累计最后画盖上去 → 视觉即堆叠分段。
  // series/data 都按倒序索引 k 同步构建，颜色、图例、悬浮值一一对应。
  const order = [];
  for (let k = parts.length - 1; k >= 0; k--) order.push(k);
  o.series = [
    { label: '日期', value: (/** @type {any} */ u, /** @type {number} */ t) => t == null ? '' : new Date(t * 1000).toLocaleDateString() },
    ...order.map((k) => ({
      label: parts[k].label,
      stroke: parts[k].color, fill: parts[k].color, width: 0,
      paths: barsPath,
      // 图例/悬浮显示原始分量而非累计
      value: (/** @type {any} */ u, /** @type {number} */ v, /** @type {number} */ si, /** @type {number} */ idx) =>
        idx == null ? '—' : String(parts[k].values[idx] || 0),
    })),
  ];
  const data = [days.map(dayToTs), ...order.map((k) => cums[k])];
  return mount(el, o, data);
}

function mount(el, opts, data) {
  el.innerHTML = '';
  const u = new uPlot(opts, data, el);
  const ro = new ResizeObserver(() => {
    const w = el.getBoundingClientRect().width;
    if (w > 0) u.setSize({ width: Math.floor(w), height: opts.height });
  });
  ro.observe(el);
  /** @type {any} */ (u)._ro = ro; // 防 GC + 页面重绘时可断开
  return u;
}

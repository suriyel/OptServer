// @ts-check
// blueprints.js —— 工作流页（对外术语；内部 blueprintId）：ECharts 图表（主视图，指标可切换）
// + 明细表（表头点击排序、点行展开详情）。数据来自 /v1/stats/blueprints 与 /stats/blueprints/series。
//
// 环比列跟随当前排序列：按 runs 排就显 runs 的环比，改排 Token 就变 Token 的环比——
// 表永远只多一列、只有一个箭头，且总与你此刻关注的指标对齐。
// 对比窗由服务器给（compare），两端都不含当日，见 lib/stats.js compareWindows。

import { getStats, makeGuard } from '../core/api.js';
import { escapeHtml, fmtInt, fmtDuration, fmtDelta, fmtLastAt, fmtSilent } from '../core/fmt.js';
import { rangeParams, todayLocal, rangeDays } from '../core/range.js';
import { makeChart, stackedBar, rankedBar, timeBars, heatmap, EC } from '../core/echarts.js';
import { downloadCsv } from '../core/download.js';
import { cmpGrid, mdLabel, rangeNote } from '../core/detail.js';

const CHART_TOP = 12; // 图表最多展示前 N 个工作流（表格展示全部）

const CHART_METRICS = [
  { value: 'outcome', label: '运行终态' },
  { value: 'tokens', label: 'Token' },
  { value: 'interruptions', label: '中断' },
];

// noCmp：该列无 cur/prev 对应字段（recency 是不带 range 的全局量），不参与环比列
const LAST_AT_TITLE = '上次实质使用（会话/run/失败；心跳不算）。「—」= 无记录：'
  + '可能从未实质使用，也可能是升级前的历史数据尚未跑 npm run backfill';
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
  { key: 'lastAt', label: '上次活跃', num: false, noCmp: true, title: LAST_AT_TITLE,
    // ISO 字典序 = 时间序；无记录归 '' 排在最旧那端
    sortVal: (r) => r.lastAt || '',
    render: (r) => fmtLastAt(r.lastAt) },
  { key: 'silentDays', label: '沉默', num: true, noCmp: true,
    title: '区间内零活动即为沉默；沉默天数超过当前范围的 2 倍时标 ⚠',
    // 无记录当作「最沉默」排在极端，不能让 null 掉进字符串比较
    sortVal: (r) => (r.silentDays == null ? Infinity : r.silentDays),
    render: (r) => {
      const s = fmtSilent(r.silentDays, rangeDays() * 2);
      return s.cls ? `<span class="${s.cls}">${s.text} ⚠</span>` : s.text;
    } },
];

// 展开面板的「本期 vs 上期」对比条指标
const CMP_METRICS = [
  { key: 'runs', label: '运行', fmt: fmtInt },
  { key: 'runsFailed', label: '失败run', fmt: fmtInt },
  { key: 'failures', label: '失败事件', fmt: fmtInt },
  { key: 'activeMs', label: '活跃时长', fmt: fmtDuration },
  { key: 'interruptions', label: '中断', fmt: fmtInt },
  { key: 'tokens', label: 'Token', fmt: fmtInt },
];

/** @type {HTMLElement} */ let root;
/** @type {any} */ let chart;
/** @type {any[]} */ let rows = [];
/** @type {any} */ let compare = null;
/** 服务器回的区间右端；等于今天时末柱不完整，标题上要说明 @type {string|null} */
let rangeTo = null;
/** 被准入线挡掉的沉默工作流个数（表底说明，保留可见性） */
let hiddenSilent = 0;
let silentMinRuns = 3;
let chartMetric = 'outcome';
let sortKey = 'runs';
let sortDesc = true;
/** 当前展开的工作流 id（一次只开一个：多实例并存既费内存又让页面跳动） @type {string|null} */
let expandedKey = null;
/** @type {any} */ let detailChart = null;
/** @type {any} */ let detailHeat = null;
const HOURS_DAYS = 30; // 作息窗口固定 30 天，不跟随顶栏 range（样本量理由见 lib/stats.js）
/** 逐日序列按 id 缓存；range 变了在 refresh 里整体作废 @type {Map<string, any>} */
const seriesCache = new Map();
/** 作息按 id 缓存。窗口固定 30 天、与顶栏 range 无关，故 range 变化**不作废**它 @type {Map<string, any>} */
const hoursCache = new Map();
/** 列表请求的代际守卫（切档位/轮询并发时丢弃先发后至的旧快照） */
const listGuard = makeGuard();

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
    <div class="panel">
      <div class="panel-head">
        <h3>明细</h3>
        <button class="export-btn" id="bp-export">导出 CSV</button>
      </div>
      <div id="bp-table"></div>
    </div>
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
    const t = /** @type {HTMLElement} */ (e.target);
    const th = t.closest('th');
    if (th && th.dataset.key) {
      if (sortKey === th.dataset.key) sortDesc = !sortDesc;
      else { sortKey = th.dataset.key; sortDesc = true; }
      renderTable();
      return;
    }
    const tr = /** @type {HTMLElement} */ (t.closest('tr[data-k]'));
    if (!tr) return;
    expandedKey = expandedKey === tr.dataset.k ? null : tr.dataset.k;
    renderTable();
  });
  el.querySelector('#bp-export').addEventListener('click', () => downloadCsv('blueprints', rangeParams()));
}

export async function refresh() {
  const errBox = root.querySelector('#bp-error');
  errBox.textContent = '';
  const g = listGuard.next();
  try {
    const d = await getStats('/stats/blueprints', rangeParams());
    if (listGuard.stale(g)) return; // 有更新的一次在途/已落地，本次结果整个丢弃（守卫必须在赋值前）
    rows = d.blueprints;
    compare = d.compare || null;
    rangeTo = d.to;
    hiddenSilent = d.hiddenSilent || 0;
    silentMinRuns = d.silentMinLifetimeRuns || 3;
    seriesCache.clear(); // range 可能变了，旧序列作废
    if (expandedKey && !rows.some((r) => r.blueprintId === expandedKey)) expandedKey = null;
    renderChart();
    renderTable();
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function renderChart() {
  // 服务器按 runs 降序返回、尾部接沉默行；沉默行全零，画进图里只是一排空条，先滤掉
  const top = rows.filter((r) => r.runs > 0).slice(0, CHART_TOP);
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

function rangeEndsToday() { return rangeTo === todayLocal(); }

// 环比列只在「排序列是数值列且有 cur/prev 对应字段」且服务器给了对比窗时出现。
// recency 两列（lastAt/silentDays）是不带 range 的全局量，没有"上期值"可言，故标 noCmp。
function cmpColumn() {
  if (!compare) return null;
  return COLUMNS.find((c) => c.key === sortKey && c.num && !c.noCmp) || null;
}

function renderTable() {
  disposeDetail();
  const sortCol = COLUMNS.find((c) => c.key === sortKey);
  const valOf = (r) => (sortCol && sortCol.sortVal ? sortCol.sortVal(r) : r[sortKey]);
  const sorted = rows.slice().sort((a, b) => {
    const av = valOf(a), bv = valOf(b);
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv : String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv));
    return sortDesc ? -cmp : cmp;
  });
  const cmpCol = cmpColumn();
  const colCount = COLUMNS.length + (cmpCol ? 1 : 0);

  const head = COLUMNS.map((c) => {
    const title = c.title ? ` title="${escapeHtml(c.title)}"` : '';
    let h = `<th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}"${title}>${c.label}`
      + (sortKey === c.key ? `<span class="arrow">${sortDesc ? '▼' : '▲'}</span>` : '') + '</th>';
    if (cmpCol && c.key === cmpCol.key) h += '<th class="num" title="本期 vs 上期，两端均不含当日">环比</th>';
    return h;
  }).join('');

  const body = sorted.map((r) => {
    const open = expandedKey === r.blueprintId;
    const cells = COLUMNS.map((c) => {
      let td;
      if (c.render) td = `<td class="${c.num ? 'num' : ''}">${c.render(r)}</td>`;
      else if (c.num) td = `<td class="num">${c.fmt ? c.fmt(r[c.key]) : fmtInt(r[c.key])}</td>`;
      else td = `<td><span class="caret">${open ? '▾' : '▸'}</span>${escapeHtml(r[c.key])}</td>`;
      if (cmpCol && c.key === cmpCol.key) {
        const d = fmtDelta(r.cur ? r.cur[c.key] : 0, r.prev ? r.prev[c.key] : 0, c.fmt);
        td += `<td class="num cmp-td ${d.cls}">${d.text}</td>`;
      }
      return td;
    }).join('');
    return `<tr class="row-x${open ? ' open' : ''}${r.runs === 0 ? ' row-silent' : ''}" data-k="${escapeHtml(r.blueprintId)}">${cells}</tr>`
      + (open ? detailRow(r, colCount) : '');
  }).join('');

  // 准入线挡掉的那些必须报个数——静默隐藏会让人以为"就这么多工作流"
  const hiddenNote = hiddenSilent > 0
    ? `<div class="table-note">已隐藏 ${hiddenSilent} 个区间内零活动且历史累计运行 &lt;${silentMinRuns} 次的工作流（多为建了跑一次就废的实验品）。</div>`
    : '';
  root.querySelector('#bp-table').innerHTML = sorted.length
    ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` + rangeNote(compare) + hiddenNote
    : '<div class="empty">范围内无工作流运行</div>' + hiddenNote;
  if (expandedKey) mountDetail();
}

function detailRow(r, colCount) {
  // 「当日不完整」写在标题行而非图内：图内标签在窄格上必被裁掉（见 core/echarts.js dimLast 注释）
  const partial = rangeEndsToday();
  return `<tr class="detail-row"><td colspan="${colCount}"><div class="detail">
      <div class="detail-title">${escapeHtml(r.blueprintId)} · 逐日运行终态${
        partial ? '<span class="detail-note">末柱为当日，数据不完整</span>' : ''}</div>
      <div class="echart detail-chart" id="bp-detail-chart"></div>
      <div class="detail-title">作息分布<span class="detail-note">固定近 ${HOURS_DAYS} 天，不受顶栏范围影响</span></div>
      <div class="echart echart-heat" id="bp-detail-heat"></div>
      ${compare ? '<div class="detail-title">本期 vs 上期</div>' + cmpGrid(r.cur, r.prev, CMP_METRICS) : ''}
    </div></td></tr>`;
}

function disposeDetail() {
  if (detailChart) { detailChart.dispose(); detailChart = null; }
  if (detailHeat) { detailHeat.dispose(); detailHeat = null; }
}

function loadingOption(text, color) {
  return { title: { text, left: 'center', top: 'middle',
    textStyle: { color: color || '#565d69', fontFamily: '"IBM Plex Mono",monospace', fontSize: 13 } } };
}

async function mountDetail() {
  const el = /** @type {HTMLElement} */ (root.querySelector('#bp-detail-chart'));
  if (!el) return;
  // 捕获**本次**实例：切档位会 dispose 旧图重挂新图，光判 expandedKey 不变是不够的
  // （同一行、不同 range 的两次挂载 key 相同），必须比实例身份才能挡住旧序列画进新图
  const inst = makeChart(el);
  detailChart = inst;
  inst.set(loadingOption('加载中…'));
  const key = expandedKey;
  try {
    let d = seriesCache.get(key);
    if (!d) {
      d = await getStats('/stats/blueprints/series', Object.assign({ id: key }, rangeParams()));
      seriesCache.set(key, d);
    }
    if (expandedKey !== key || detailChart !== inst) return; // 期间已折叠/换行/换档，丢弃这次结果
    const days = d.days;
    inst.set(timeBars({
      categories: days.map((x) => mdLabel(x.day)),
      partialLast: days.length > 0 && days[days.length - 1].day === todayLocal(),
      series: [
        { name: '成功', color: EC.green, values: days.map((x) => x.runsDone) },
        { name: '失败', color: EC.red, values: days.map((x) => x.runsFailed) },
        { name: '中止', color: EC.orange, values: days.map((x) => x.runsHalted) },
      ],
    }));
  } catch (e) {
    if (detailChart === inst) inst.set(loadingOption('序列加载失败：' + /** @type {Error} */ (e).message, '#e8615f'));
  }
  mountDetailHeat(key);
}

// 作息热力图：与日曲线各自独立请求（窗口不同——日曲线跟 range，热力图固定 30 天），
// 故也各自独立缓存与守卫，一个失败不拖累另一个。
async function mountDetailHeat(key) {
  const el = /** @type {HTMLElement} */ (root.querySelector('#bp-detail-heat'));
  if (!el) return;
  const inst = makeChart(el);
  detailHeat = inst;
  inst.set(loadingOption('加载中…'));
  try {
    let d = hoursCache.get(key);
    if (!d) {
      d = await getStats('/stats/hours', { blueprintId: key, days: String(HOURS_DAYS) });
      hoursCache.set(key, d);
    }
    if (expandedKey !== key || detailHeat !== inst) return;
    if (!d.cells.length) { inst.set(loadingOption(`近 ${HOURS_DAYS} 天无运行记录`)); return; }
    inst.set(heatmap({ cells: d.cells.map((c) => ({ ...c, value: c.events })), valueFmt: fmtInt }));
  } catch (e) {
    if (detailHeat === inst) inst.set(loadingOption('作息加载失败：' + /** @type {Error} */ (e).message, '#e8615f'));
  }
}

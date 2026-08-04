// @ts-check
// users.js —— 用户页：Top N 高频用户。ECharts 横向排名条形图（主视图）+ 明细表（点行展开详情）。
// metric 分段控件（会话/run/token/时长/失败）→ 重查 /v1/stats/users/top?metric=（服务器排序）。
//
// 环比列跟在当前 metric 那一列后面（用户页由 metric 而非表头点击决定排序）。
// 展开详情画的也是当前 metric 的逐日曲线，与页面焦点保持一致。

import { getStats, makeGuard } from '../core/api.js';
import { escapeHtml, fmtInt, fmtDuration, fmtDelta, fmtLastAt, fmtSilent } from '../core/fmt.js';
import { rangeParams, todayLocal, rangeDays } from '../core/range.js';
import { makeChart, rankedBar, timeLine, EC } from '../core/echarts.js';
import { downloadCsv } from '../core/download.js';
import { cmpGrid, mdLabel, rangeNote } from '../core/detail.js';

// 区间指标：value 同时是表列 key、排序 metric 与 cur/prev 字段名——三者同名是刻意的，省掉一层映射
const METRICS = [
  { value: 'sessions', label: '会话数', color: EC.amber, fmt: fmtInt },
  { value: 'runs', label: 'run 数', color: EC.cyan, fmt: fmtInt },
  { value: 'tokens', label: 'Token', color: EC.violet, fmt: fmtInt },
  { value: 'sessionMs', label: '活跃时长', color: EC.blue, fmt: fmtDuration },
  { value: 'failures', label: '失败数', color: EC.red, fmt: fmtInt },
];

// 分段控件 = 区间指标 + 沉默天数。silentDays 与前五个**不同源**：它是不带 range 的全局量，
// 服务端另走一支（按 recency 排名，能排出区间内零活动、qTopUsers 永远排不到的流失用户）。
// 因此它只进分段控件与表列，不进对比条（无上期值）、也不做详情日曲线的纵轴。
const SILENT_METRIC = { value: 'silentDays', label: '沉默天数', color: EC.muted };
const SEGMENTS = METRICS.concat(SILENT_METRIC);

const CMP_METRICS = METRICS.map((m) => ({ key: m.value, label: m.label, fmt: m.fmt }));

const LAST_AT_TITLE = '上次实质使用（会话/run/失败；心跳不算）。「—」= 无记录：'
  + '可能只装了从未实质使用，也可能是升级前的历史数据尚未跑 npm run backfill';

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
        <h3 id="us-heading">高频用户 Top 10</h3>
        <div class="metric-seg" id="us-seg">
          ${SEGMENTS.map((m) => `<button data-m="${m.value}"${m.value === metric ? ' class="on"' : ''}>${m.label}</button>`).join('')}
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
    // 沉默排行取 50：流失名单的用处是**看全**，Top 10 只够看最久的那几个。
    // 与服务端 SILENT_RANK_DEFAULT_LIMIT 同值——这里显式传是因为普通榜要 10，不能共用缺省。
    const params = Object.assign({ metric, limit: isSilentMode() ? '50' : '10' }, rangeParams());
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

function metricDef() { return SEGMENTS.find((x) => x.value === metric) || METRICS[0]; }
const isSilentMode = () => metric === 'silentDays';
/** 详情日曲线的纵轴：沉默模式下没有"逐日沉默"这种量，退回会话数 */
function seriesMetricDef() { return isSilentMode() ? METRICS[0] : metricDef(); }

function renderChart() {
  const m = metricDef();
  root.querySelector('#us-heading').textContent = isSilentMode()
    ? `最久未使用 Top ${users.length}` // 「高频用户」在沉默模式下是说反的
    : `高频用户 Top ${users.length}`;
  // 条数随 metric 变（沉默榜 50 条），固定 380px 会把 50 根柱子压成 7px 的糊墙。
  // 让图高随行数走，图与表始终展示同一批人——不搞「图只画前 N 个」那种图表不一致。
  const el = /** @type {HTMLElement} */ (root.querySelector('#us-chart'));
  el.style.height = Math.max(380, users.length * 15 + 56) + 'px';
  chart.inst.resize();
  // 服务器已按 metric 降序（沉默模式按 lastAt 升序 = 沉默天数降序）；条形图最大值置顶
  chart.set(rankedBar({
    categories: users.map((u) => u.user + '@' + u.host),
    // 无记录（null）在图上按 0 画：柱子为空，与表格里的「—」呼应，不伪造一个巨大值
    values: users.map((u) => (isSilentMode() ? (u.silentDays == null ? 0 : u.silentDays) : (u[metric] || 0))),
    color: m.color,
    valueFmt: isSilentMode() ? ((v) => v + ' 天') : m.fmt,
  }));
}

function renderTable() {
  disposeDetail();
  if (!users.length) { root.querySelector('#us-table').innerHTML = '<div class="empty">范围内无用户活动</div>'; return; }
  // #、用户 + 5 个区间指标 + 上次活跃 + 沉默 + 可选环比列
  const colCount = 4 + METRICS.length + (compare ? 1 : 0);
  const warnOver = rangeDays() * 2;

  const head = '<th class="num">#</th><th>用户</th>' + METRICS.map((m) => {
    const on = m.value === metric ? ' style="color:var(--amber)"' : '';
    let h = `<th class="num"${on}>${m.label}</th>`;
    // 环比只跟区间指标走；沉默列是不带 range 的全局量，没有"上期值"
    if (compare && m.value === metric) h += '<th class="num" title="本期 vs 上期，两端均不含当日">环比</th>';
    return h;
  }).join('')
    + `<th title="${escapeHtml(LAST_AT_TITLE)}">上次活跃</th>`
    + `<th class="num${isSilentMode() ? '" style="color:var(--amber)' : ''}"`
    + ' title="区间内零活动即为沉默；沉默天数超过当前范围的 2 倍时标 ⚠">沉默</th>';

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
    const s = fmtSilent(u.silentDays, warnOver);
    const silentCell = `<td class="num">${s.cls ? `<span class="${s.cls}">${s.text} ⚠</span>` : s.text}</td>`;
    return `<tr class="row-x${open ? ' open' : ''}${u.sessions === 0 && u.runs === 0 ? ' row-silent' : ''}" data-k='${escapeHtml(k)}'>
        <td class="num"><span class="rank${i < 3 ? ' top' : ''}">${i + 1}</span></td>
        <td><span class="caret">${open ? '▾' : '▸'}</span>${escapeHtml(u.user)}@${escapeHtml(u.host)}</td>
        ${cells}
        <td>${fmtLastAt(u.lastAt)}</td>
        ${silentCell}
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
      <div class="detail-title">${escapeHtml(u.user)}@${escapeHtml(u.host)} · 逐日${escapeHtml(seriesMetricDef().label)}${
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
  const m = seriesMetricDef().value; // 沉默模式退回会话数（没有"逐日沉默"这种量）
  if (m === 'runs') return x.runsDone + x.runsFailed + x.runsHalted;
  if (m === 'tokens') return x.inTokens + x.outTokens;
  return x[m] || 0;
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
    const m = seriesMetricDef();
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

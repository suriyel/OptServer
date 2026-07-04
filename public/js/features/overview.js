// @ts-check
// overview.js —— 概览页：今日/在线/周活 stat 卡 + 版本环图（纯 CSS conic-gradient）+ 工具占比条形

import { getStats } from '../core/api.js';
import { escapeHtml, fmtInt, fmtDuration } from '../core/fmt.js';
import { COLORS } from '../core/charts.js';

const DONUT_COLORS = [COLORS.amber, COLORS.blue, COLORS.green, COLORS.purple, COLORS.orange, COLORS.muted];

/** @type {HTMLElement} */ let root;

export function init(el) {
  root = el;
  el.innerHTML = `
    <div class="cards" id="ov-cards"></div>
    <div class="panel-row">
      <div class="panel"><h3>版本分布（近 30 天活跃实例）</h3><div id="ov-versions"></div></div>
      <div class="panel"><h3>工具会话占比</h3><div id="ov-tools"></div></div>
    </div>
    <div class="error-box" id="ov-error"></div>`;
}

export async function refresh() {
  const errBox = root.querySelector('#ov-error');
  errBox.textContent = '';
  try {
    const [ov, vers, tools] = await Promise.all([
      getStats('/stats/overview'),
      getStats('/stats/versions'),
      getStats('/stats/tools'), // 缺省近 30 天；范围选择只影响趋势/失败页，占比页保持口径稳定
    ]);
    renderCards(ov);
    renderVersions(vers.versions);
    renderTools(tools.tools);
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    throw e;
  }
}

function card(label, value, unit) {
  return `<div class="card"><div class="card-label">${label}</div>
    <div class="card-value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div></div>`;
}

function renderCards(ov) {
  root.querySelector('#ov-cards').innerHTML =
    card('今日活跃用户', fmtInt(ov.activeUsersToday))
    + card('在线实例（10 分钟内）', fmtInt(ov.onlineInstalls))
    + card('本周活跃用户', fmtInt(ov.activeUsersWeek))
    + card('今日会话', fmtInt(ov.sessionsToday))
    + card('今日会话时长', fmtDuration(ov.sessionMsToday))
    + card('今日 run / 失败', fmtInt(ov.runsToday) + ' / ' + fmtInt(ov.failuresToday));
}

function renderVersions(versions) {
  const box = root.querySelector('#ov-versions');
  if (!versions.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const total = versions.reduce((s, v) => s + v.installs, 0);
  let acc = 0;
  const segs = versions.map((v, i) => {
    const from = (acc / total) * 360; acc += v.installs;
    const to = (acc / total) * 360;
    return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${from.toFixed(1)}deg ${to.toFixed(1)}deg`;
  });
  const legend = versions.map((v, i) =>
    `<div class="legend-item"><span class="swatch" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></span>
     <span>${escapeHtml(v.version)}</span>
     <span class="legend-val">${fmtInt(v.installs)} 实例 · ${fmtInt(v.users)} 人</span></div>`).join('');
  box.innerHTML = `
    <div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${segs.join(',')})" data-center="${total}\n实例"></div>
      <div class="legend">${legend}</div>
    </div>`;
}

function renderTools(tools) {
  const box = root.querySelector('#ov-tools');
  if (!tools.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const max = Math.max(...tools.map((x) => x.sessions), 1);
  box.innerHTML = '<div class="barlist">' + tools.map((x) => `
    <div class="bar-row">
      <span class="bar-name" title="${escapeHtml(x.tool)}">${escapeHtml(x.tool)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(x.sessions / max * 100).toFixed(1)}%"></div></div>
      <span class="bar-val">${fmtInt(x.sessions)} · ${fmtDuration(x.sessionMs)}</span>
    </div>`).join('') + '</div>';
}

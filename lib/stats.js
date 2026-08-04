'use strict';
// stats.js —— 查询聚合 API（看板唯一契约）：GET /v1/stats/* + /v1/installs。
// 读路径全部走 daily_* / installs（毫秒级）；仅 failures 按设计文档读 events 原始表。
// 响应统一 { ok: true, data }；时间参数 from/to 为本地日 YYYY-MM-DD（含端点）。

const express = require('express');
const { localDay, shiftDay } = require('./time-utils');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function spanDays(from, to) {
  return Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / DAY_MS);
}

// from/to 解析：缺省 to=今日、from=to-29；非法/倒置/跨度>400 天 → null
function parseRange(query, now) {
  const to = query.to != null ? String(query.to) : localDay(now);
  if (!DAY_RE.test(to)) return null;
  const from = query.from != null ? String(query.from) : shiftDay(to, -29);
  if (!DAY_RE.test(from)) return null;
  if (from > to || spanDays(from, to) > 400) return null;
  return { from, to };
}

// [from..to] 逐日串（含端点）
function dayList(from, to) {
  const days = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) days.push(d);
  return days;
}

/**
 * 环比对比窗：本期与上期**都截至昨日**，各取 range 同长度的完整天。
 *
 * 缺省 range=[今天-29, 今天] 时 → 本期 [今天-30, 今天-1]、上期 [今天-60, 今天-31]。
 * 刻意不复用 range 本身作分子：range 末尾的「今天」只过了一半，直接比会让每天上午
 * 一片飘红、下午转绿——纯假信号。主表总量与日曲线仍含今日（那是实时感），只有环比排除它。
 * 显式历史区间（to < 今天）时本期即 range 自身，上期为紧邻的等长窗口。
 *
 * @returns {{cur:{from:string,to:string}, prev:{from:string,to:string}} | null}
 *   range 内一天完整日都没有（如 from=to=今天）时返回 null——此时无从谈环比。
 */
function compareWindows(range, now) {
  const yesterday = shiftDay(localDay(now), -1);
  const curTo = range.to < yesterday ? range.to : yesterday;
  if (curTo < range.from) return null;
  const n = spanDays(range.from, range.to) + 1; // range 天数（含端点）
  const curFrom = shiftDay(curTo, -(n - 1));
  const prevTo = shiftDay(curFrom, -1);
  return { cur: { from: curFrom, to: curTo }, prev: { from: shiftDay(prevTo, -(n - 1)), to: prevTo } };
}

// 环比用指标子集：只留数值列，键与列表行同名，前端按当前排序键直接取同名字段
const BP_CMP_KEYS = ['runs', 'runsDone', 'runsFailed', 'runsHalted', 'failures',
  'activeMs', 'interruptions', 'inTokens', 'outTokens', 'tokens'];
const USER_CMP_KEYS = ['sessions', 'runs', 'failures', 'sessionMs', 'inTokens', 'outTokens', 'tokens'];

function pickCmp(row, keys) {
  const o = {};
  for (const k of keys) o[k] = row ? (row[k] || 0) : 0;
  return o;
}

/**
 * 沉默工作流的准入线：**历史累计** runs ≥ 3 才进沉默名单。
 *
 * blueprintId 是用户可控且只增不减的（蚕丛支持自建/复制蓝图，`bp-` 是保留前缀）。千人跑一两年，
 * 历史累计几百上千个 id 完全可能，绝大多数是「建了跑一次就废」的实验品。不设线，沉默名单会被
 * 它们淹没，恰好埋掉真正想找的「曾经在用、现在不用了」。表底会报被隐藏的个数，保留可见性。
 * 用户侧**不设**此线——user@host 来自真实机器，基数受人数约束，这是有意的不对称。
 */
const SILENT_MIN_LIFETIME_RUNS = 3;

// 作息热力图的固定窗口：30 天让每个「周几×小时」格子有 4~5 个样本，是能看出规律的最小量级。
// 上限 400 与 parseRange 的跨度上限同源（daily_hour 永久保留，理论上可查更久）。
const HOURS_DEFAULT_DAYS = 30;
const HOURS_MAX_DAYS = 400;

// users/top 的默认条数（上限统一 100）。两个默认值不同是刻意的，见 metric=silentDays 分支注释。
const TOP_DEFAULT_LIMIT = 10;
const SILENT_RANK_DEFAULT_LIMIT = 50;

/**
 * 「沉默天数」：上次实质使用的本地日距今天的天数；今天用过 = 0。
 * lastAt 为空 = 从未实质使用（只有心跳/只装未用）→ null，前端渲染为「从未」而非 0 或 NaN。
 */
function silentDaysOf(lastAt, today) {
  if (!lastAt) return null;
  const d = new Date(lastAt);
  if (isNaN(d.getTime())) return null;
  return Math.max(0, spanDays(localDay(d), today));
}

const ZERO_BP = { runsDone: 0, runsFailed: 0, runsHalted: 0, failures: 0, activeMs: 0,
  interruptions: 0, inTokens: 0, outTokens: 0, runs: 0, tokens: 0 };
const ZERO_USER = { sessions: 0, runs: 0, failures: 0, sessionMs: 0,
  inTokens: 0, outTokens: 0, tokens: 0 };

const withBpTotals = (b) => ({
  ...b, runs: b.runsDone + b.runsFailed + b.runsHalted, tokens: b.inTokens + b.outTokens,
});
const withUserTotals = (u) => ({ ...u, tokens: u.inTokens + u.outTokens });

/**
 * 工作流行装配：区间行 + recency + 沉默行（过准入线的）。**看板与 CSV 共用**，
 * 保证「导出与看板同口径」这条既有纪律不被第二份实现悄悄破坏。
 * @returns {{rows: any[], hiddenSilent: number}} rows 已按「区间内按 runs 降序 → 沉默行按最近沉默」排列
 */
function assembleBlueprints(dao, range, today) {
  const inRangeRows = dao.qBlueprints(range.from, range.to).map(withBpTotals);
  const rec = new Map(dao.qBlueprintRecency().map((x) => [x.blueprintId, x]));
  const inRange = new Set(inRangeRows.map((b) => b.blueprintId));
  let hiddenSilent = 0;
  const silent = [];
  for (const e of rec.values()) {
    if (inRange.has(e.blueprintId)) continue;
    if ((e.lifetimeRuns || 0) < SILENT_MIN_LIFETIME_RUNS) { hiddenSilent++; continue; }
    silent.push({ blueprintId: e.blueprintId, ...ZERO_BP });
  }
  silent.sort((a, b) => String(rec.get(b.blueprintId).lastAt || '')
    .localeCompare(String(rec.get(a.blueprintId).lastAt || '')));
  const decorate = (b) => {
    const e = rec.get(b.blueprintId);
    return { ...b,
      lastAt: e ? e.lastAt : null,
      lifetimeRuns: e ? e.lifetimeRuns : 0,
      silentDays: silentDaysOf(e && e.lastAt, today) };
  };
  return { rows: inRangeRows.map(decorate).concat(silent.map(decorate)), hiddenSilent };
}

/**
 * 全量用户行装配（导出用）：区间内有活动的 + 历史上有过但区间内零活动的（沉默用户）。
 * 用户侧**不设**准入线——user@host 来自真实机器，基数受人数约束（与工作流的不对称是刻意的）。
 */
function assembleUsersAll(dao, range, today) {
  const inRangeRows = dao.qUsersAll(range.from, range.to).map(withUserTotals);
  const rec = new Map(dao.qUserRecency().map((x) => [x.user + '@' + x.host, x]));
  const inRange = new Set(inRangeRows.map((u) => u.user + '@' + u.host));
  const silent = [];
  for (const e of rec.values()) {
    const k = e.user + '@' + e.host;
    if (!inRange.has(k)) silent.push({ user: e.user, host: e.host, ...ZERO_USER });
  }
  silent.sort((a, b) => String(rec.get(b.user + '@' + b.host).lastAt || '')
    .localeCompare(String(rec.get(a.user + '@' + a.host).lastAt || '')));
  const decorate = (u) => {
    const e = rec.get(u.user + '@' + u.host);
    return { ...u, lastAt: e ? e.lastAt : null, silentDays: silentDaysOf(e && e.lastAt, today) };
  };
  return inRangeRows.map(decorate).concat(silent.map(decorate));
}

// 非空字符串参数（实体键）：缺失/空/超长 → null，由调用方回 400
function entityKey(v, max) {
  if (v == null) return null;
  const s = String(v);
  return (s.length > 0 && s.length <= (max || 256)) ? s : null;
}

function createStatsRouter(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const router = express.Router();

  // 路由级 try/catch 收口：任何查询异常 → 500 { ok:false }，不裸崩
  function handle(fn) {
    return (req, res) => {
      try { fn(req, res); } catch (e) {
        console.log('[stats] error:', e.message);
        res.status(500).json({ ok: false, error: 'stats failed' });
      }
    };
  }

  function rangeOr400(req, res) {
    const r = parseRange(req.query, nowFn());
    if (!r) res.status(400).json({ ok: false, error: 'bad range' });
    return r;
  }

  router.get('/stats/overview', handle((req, res) => {
    const now = nowFn();
    const today = localDay(now);
    // last_seen 与比较值同为 toISOString() 串，字典序即时间序，无需解析
    const onlineSince = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const totals = dao.qTodayTotals(today);
    res.json({ ok: true, data: {
      today,
      activeUsersToday: dao.qCountActiveUsersOn(today),
      activeUsersWeek: dao.qCountActiveUsersSince(shiftDay(today, -6)), // 今日含内 7 天
      onlineInstalls: dao.qCountOnline(onlineSince),
      sessionsToday: totals.sessions,
      sessionMsToday: totals.sessionMs,
      runsToday: totals.runs,
      failuresToday: totals.failures,
      inTokensToday: totals.inTokens,   // token 总量来自 session_end（daily_user）
      outTokensToday: totals.outTokens,
    } });
  }));

  router.get('/stats/dau', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    const byDay = new Map(dao.qDauRange(r.from, r.to).map((x) => [x.day, x]));
    // WAU 滑窗在 JS 里做：取 (day, user@host) 去重行、范围左扩 6 天，逐日并集计数
    // （9 万行量级毫秒级；纯 SQL 自连接反而 O(n²)）
    const userDays = new Map(); // day -> Set<uk>
    for (const row of dao.qDauUsers(shiftDay(r.from, -6), r.to)) {
      if (!userDays.has(row.day)) userDays.set(row.day, new Set());
      userDays.get(row.day).add(row.uk);
    }
    const days = dayList(r.from, r.to).map((day) => {
      const cur = byDay.get(day);
      const wauSet = new Set();
      for (let i = 0; i < 7; i++) {
        const s = userDays.get(shiftDay(day, -i));
        if (s) for (const u of s) wauSet.add(u);
      }
      return {
        day,
        dau: cur ? cur.dau : 0,
        wau: wauSet.size,
        sessions: cur ? cur.sessions : 0,
        sessionMs: cur ? cur.sessionMs : 0,
        inTokens: cur ? cur.inTokens : 0,
        outTokens: cur ? cur.outTokens : 0,
      };
    });
    res.json({ ok: true, data: { from: r.from, to: r.to, days } });
  }));

  router.get('/stats/versions', handle((req, res) => {
    // 版本分布按 install 最新心跳（app_version 随每次上报 upsert）；30 天不活跃的僵尸装机不计
    const since = new Date(nowFn().getTime() - 30 * DAY_MS).toISOString();
    res.json({ ok: true, data: { versions: dao.qVersions(since) } });
  }));

  router.get('/stats/tools', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    res.json({ ok: true, data: { from: r.from, to: r.to, tools: dao.qTools(r.from, r.to) } });
  }));

  router.get('/stats/runs', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    const byDay = new Map(dao.qRuns(r.from, r.to).map((x) => [x.day, x]));
    const days = dayList(r.from, r.to).map((day) => {
      const cur = byDay.get(day);
      return {
        day,
        done: cur ? cur.done : 0,
        failed: cur ? cur.failed : 0,
        halted: cur ? cur.halted : 0,
        activeMs: cur ? cur.activeMs : 0,
      };
    });
    res.json({ ok: true, data: { from: r.from, to: r.to, days } });
  }));

  router.get('/stats/failures', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    // 按版本失败率：failure_event 数 / bp_run_end 数（runs=0 时 rate 为 null 而非除零）
    const runsByVersion = new Map(dao.qRunEndsByVersion(r.from, r.to).map((x) => [x.version, x.n]));
    const byVersion = dao.qFailuresByVersion(r.from, r.to).map((x) => {
      const runs = runsByVersion.get(x.version) || 0;
      return { version: x.version, failures: x.n, runs, rate: runs > 0 ? x.n / runs : null };
    });
    const recent = dao.qRecentFailures(r.from, r.to, 100).map((x) => {
      let payload = null;
      try { payload = JSON.parse(x.payload); } catch (_) { /* 坏 payload 原样置 null */ }
      // update_apply{ok:false} 与 failure_event 同列（type 字段区分；看板据此渲染 kind='update:<reason>'）
      return { eventId: x.eventId, serverTs: x.serverTs, user: x.user, host: x.host,
        appVersion: x.appVersion, type: x.type || 'failure_event', payload };
    });
    res.json({ ok: true, data: {
      from: r.from, to: r.to,
      kinds: dao.qFailureKinds(r.from, r.to),
      byVersion, recent,
    } });
  }));

  // Top 用户：metric 白名单排序（会话数/run 数/失败/时长/token），limit 默认 10、上限 100
  router.get('/stats/users/top', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    const metric = req.query.metric != null ? String(req.query.metric) : 'sessions';
    if (!dao.topUserMetrics.includes(metric)) {
      return res.status(400).json({ ok: false, error: 'bad metric' });
    }
    // 沉默排行的默认条数比高频榜大得多：Top 10 只够看「最久不用的 10 个」，
    // 而流失名单的用处恰恰是**看全**——几十个人不用了才是要处理的信号。
    const dfltLimit = metric === 'silentDays' ? SILENT_RANK_DEFAULT_LIMIT : TOP_DEFAULT_LIMIT;
    const limitRaw = req.query.limit != null ? Number(req.query.limit) : dfltLimit;
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : dfltLimit), 100);
    const now = nowFn();
    const today = localDay(now);

    let rows;
    // 全表 recency 只在沉默排行时取——那是唯一必须"看全所有人"才排得出名次的路径。
    // 普通 metric 路径改为对返回的 ≤100 行做点查（实测 0.02ms vs 全表 87ms @73 万行）。
    let recUsers = null;
    if (metric === 'silentDays') {
      // 沉默排行走**不带 range** 的 recency：range 内零活动的人在区间聚合里根本没有行，
      // 沿用 qTopUsers 永远排不出他们。lastAt 升序 = 沉默天数降序；NULL（装了从没用过）
      // 排最前——那是最强的信号，不是缺数据。
      recUsers = dao.qUserRecency();
      const zero = ZERO_USER;
      const inRangeBy = new Map(dao.qUsersAll(r.from, r.to)
        .map((u) => [u.user + '@' + u.host, withUserTotals(u)]));
      rows = recUsers.slice()
        .sort((a, b) => {
          if (!a.lastAt && !b.lastAt) return 0;
          if (!a.lastAt) return -1;
          if (!b.lastAt) return 1;
          return String(a.lastAt).localeCompare(String(b.lastAt));
        })
        .slice(0, limit)
        .map((x) => ({ user: x.user, host: x.host,
          ...(inRangeBy.get(x.user + '@' + x.host) || zero) }));
    } else {
      rows = dao.qTopUsers(r.from, r.to, metric, limit).map(withUserTotals);
      recUsers = dao.qUserRecencyFor(rows.map((u) => ({ user: u.user, host: u.host })));
    }
    const recBy = new Map(recUsers.map((x) => [x.user + '@' + x.host, x]));
    // 对比窗取全量用户（qUsersAll）后按 user@host 索引：Top N 之外的人不需要，
    // 但对比窗里的排名与 range 内未必一致，只能全取再查表。
    const cmp = compareWindows(r, now);
    const index = (from, to) => new Map(dao.qUsersAll(from, to)
      .map((u) => [u.user + '@' + u.host, withUserTotals(u)]));
    const curBy = cmp ? index(cmp.cur.from, cmp.cur.to) : null;
    const prevBy = cmp ? index(cmp.prev.from, cmp.prev.to) : null;
    const users = rows.map((u) => {
      const k = u.user + '@' + u.host;
      const e = recBy.get(k);
      const out = { ...u,
        lastAt: e ? e.lastAt : null,
        silentDays: silentDaysOf(e && e.lastAt, today) };
      if (cmp) {
        out.cur = pickCmp(curBy.get(k), USER_CMP_KEYS);
        out.prev = pickCmp(prevBy.get(k), USER_CMP_KEYS);
      }
      return out;
    });
    res.json({ ok: true, data: { from: r.from, to: r.to, metric, compare: cmp, today, users } });
  }));

  // 单用户（user@host）逐日序列（详情面板）。user/host 分开传，避免 '@' 出现在用户名里时切不开。
  router.get('/stats/users/series', handle((req, res) => {
    const user = entityKey(req.query.user);
    const host = entityKey(req.query.host);
    if (!user || !host) return res.status(400).json({ ok: false, error: 'bad user/host' });
    const r = rangeOr400(req, res);
    if (!r) return;
    const byDay = new Map(dao.qUserSeries(user, host, r.from, r.to).map((x) => [x.day, x]));
    const days = dayList(r.from, r.to).map((day) => {
      const c = byDay.get(day);
      return { day,
        sessions: c ? c.sessions : 0, sessionMs: c ? c.sessionMs : 0,
        runsDone: c ? c.runsDone : 0, runsFailed: c ? c.runsFailed : 0, runsHalted: c ? c.runsHalted : 0,
        failures: c ? c.failures : 0, activeMs: c ? c.activeMs : 0,
        inTokens: c ? c.inTokens : 0, outTokens: c ? c.outTokens : 0 };
    });
    res.json({ ok: true, data: { user, host, from: r.from, to: r.to, days } });
  }));

  // 工作流（对外术语；内部 blueprint）维度：runs/失败/activeMs/中断/token，按 run 总数倒序，
  // 尾部接沉默工作流（区间内零活动但历史跑过 ≥ SILENT_MIN_LIFETIME_RUNS 次）。
  // 每行附 lastAt/silentDays 与 cur/prev 两个对比窗聚合（见 compareWindows）。
  router.get('/stats/blueprints', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    const now = nowFn();
    const today = localDay(now);
    const { rows, hiddenSilent } = assembleBlueprints(dao, r, today);
    const cmp = compareWindows(r, now);
    // 本期窗与 range 重合时（显式历史区间）直接复用区间行，省一次查询
    const sameAsRange = cmp && cmp.cur.from === r.from && cmp.cur.to === r.to;
    const curBy = cmp ? new Map((sameAsRange ? rows : dao.qBlueprints(cmp.cur.from, cmp.cur.to).map(withBpTotals))
      .map((x) => [x.blueprintId, x])) : null;
    const prevBy = cmp ? new Map(dao.qBlueprints(cmp.prev.from, cmp.prev.to).map(withBpTotals)
      .map((x) => [x.blueprintId, x])) : null;
    // 沉默行照样带 cur/prev：一个 40 天前还在跑、近 30 天停了的工作流，上期窗有数、本期窗为 0，
    // 环比会给出一个大负值——那正是最该被看见的信号
    const blueprints = cmp ? rows.map((b) => ({ ...b,
      cur: pickCmp(curBy.get(b.blueprintId), BP_CMP_KEYS),
      prev: pickCmp(prevBy.get(b.blueprintId), BP_CMP_KEYS),
    })) : rows;
    res.json({ ok: true, data: {
      from: r.from, to: r.to, compare: cmp, today,
      silentMinLifetimeRuns: SILENT_MIN_LIFETIME_RUNS, hiddenSilent, blueprints,
    } });
  }));

  // 单工作流逐日序列（详情面板）。缺零日补 0，与 /stats/runs 同做法。
  router.get('/stats/blueprints/series', handle((req, res) => {
    const id = entityKey(req.query.id);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const r = rangeOr400(req, res);
    if (!r) return;
    const byDay = new Map(dao.qBlueprintSeries(id, r.from, r.to).map((x) => [x.day, x]));
    const days = dayList(r.from, r.to).map((day) => {
      const c = byDay.get(day);
      return { day,
        runsDone: c ? c.runsDone : 0, runsFailed: c ? c.runsFailed : 0, runsHalted: c ? c.runsHalted : 0,
        failures: c ? c.failures : 0, activeMs: c ? c.activeMs : 0, interruptions: c ? c.interruptions : 0,
        inTokens: c ? c.inTokens : 0, outTokens: c ? c.outTokens : 0 };
    });
    res.json({ ok: true, data: { id, from: r.from, to: r.to, days } });
  }));

  // 作息（使用时段分布）：24×7 热力图。
  //
  // 窗口**固定**（默认近 30 天）且**不跟随顶栏 range**——这是刻意的：7 天档下每个
  // 「周几×小时」格子只有 1 个样本，那不是作息规律是随机噪声，而热力图看起来很有信息量，
  // 比没有图更糟。顶栏 range 的语义是「统计区间」，作息是个相对稳定的结构量，本就不该同步。
  //
  // 口径警告（UI 必须显示）：daily_hour 的 day/hour 同源于 client_ts，与 daily_* 的 server
  // 归日**不是一套**，两表不可对账；全局行也**不等于**各工作流行之和（会话类事件无 blueprintId）。
  router.get('/stats/hours', handle((req, res) => {
    let days = Number(req.query.days);
    if (!Number.isFinite(days) || days <= 0) days = HOURS_DEFAULT_DAYS;
    days = Math.min(Math.round(days), HOURS_MAX_DAYS);
    const bp = req.query.blueprintId != null ? String(req.query.blueprintId) : '';
    if (bp.length > 256) return res.status(400).json({ ok: false, error: 'bad id' });

    const today = localDay(nowFn());
    const from = shiftDay(today, -(days - 1));
    const rows = dao.qHours(bp, from, today);

    // 折成 周几×小时。周几从 day 串推：用 T12:00:00Z 取 UTC 星期，避开任何时区把日期推前/后一天
    const cells = [];
    const idx = new Map();
    for (const r of rows) {
      const wd = new Date(r.day + 'T12:00:00Z').getUTCDay(); // 0=周日
      const k = wd * 24 + r.hour;
      let c = idx.get(k);
      if (!c) { c = { weekday: wd, hour: r.hour, events: 0, sessions: 0, runs: 0 }; idx.set(k, c); cells.push(c); }
      c.events += r.events; c.sessions += r.sessions; c.runs += r.runs;
    }
    // coveredDays 不等于 days——头几天可能尚无数据，或 events 已过保留期而无从重建
    const covered = new Set(rows.map((r) => r.day));
    res.json({ ok: true, data: {
      blueprintId: bp, days, from, to: today,
      firstDay: rows.length ? rows[0].day : null,
      coveredDays: covered.size,
      droppedClockSkew: dao.qHourDropped(),
      cells,
    } });
  }));

  // 实时：近 window 分钟(默认/上限 24h)按分钟分桶直查 events。只返回非空桶，补零交前端。
  // 进程内 30s 响应 memo（设计文档 §8.3 备用旋钮）：24h/1min 直查需扫 ~10 万行、~1s 级；
  // 但分钟桶 60s 才变、看板 60s 刷新，故按 window 缓存 30s，多看板共享、摊薄重算，端点侧近即时。
  const REALTIME_TTL_MS = 30000;
  let rtMemo = null; // { key, at, data }
  router.get('/stats/realtime', handle((req, res) => {
    const now = nowFn();
    let window = Number(req.query.window);
    if (!Number.isFinite(window) || window <= 0) window = 1440;
    window = Math.min(Math.round(window), 1440);
    if (rtMemo && rtMemo.key === window && (Date.now() - rtMemo.at) < REALTIME_TTL_MS) {
      return res.json({ ok: true, data: rtMemo.data });
    }
    const from = new Date(now.getTime() - window * 60 * 1000);
    const data = { window, now: now.toISOString(),
      buckets: dao.qRealtime(from.toISOString(), localDay(from)) };
    rtMemo = { key: window, at: Date.now(), data };
    res.json({ ok: true, data });
  }));

  router.get('/installs', handle((req, res) => {
    res.json({ ok: true, data: { installs: dao.qInstalls() } });
  }));

  return router;
}

module.exports = { createStatsRouter, parseRange, shiftDay, dayList, compareWindows,
  // 供 export.js 复用，保证 CSV 与看板同口径（两份实现必然漂移，这条纪律靠共享装配兜住）
  assembleBlueprints, assembleUsersAll, silentDaysOf, SILENT_MIN_LIFETIME_RUNS };

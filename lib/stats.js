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
      return { eventId: x.eventId, serverTs: x.serverTs, user: x.user, host: x.host,
        appVersion: x.appVersion, payload };
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
    const limit = req.query.limit != null ? Number(req.query.limit) : 10;
    const users = dao.qTopUsers(r.from, r.to, metric, Number.isFinite(limit) ? limit : 10)
      .map((u) => ({ ...u, tokens: u.inTokens + u.outTokens }));
    res.json({ ok: true, data: { from: r.from, to: r.to, metric, users } });
  }));

  // 工作流（对外术语；内部 blueprint）维度：runs/失败/activeMs/中断/token，按 run 总数倒序
  router.get('/stats/blueprints', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    const blueprints = dao.qBlueprints(r.from, r.to).map((b) => ({
      ...b, runs: b.runsDone + b.runsFailed + b.runsHalted, tokens: b.inTokens + b.outTokens,
    }));
    res.json({ ok: true, data: { from: r.from, to: r.to, blueprints } });
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

module.exports = { createStatsRouter, parseRange, shiftDay, dayList };

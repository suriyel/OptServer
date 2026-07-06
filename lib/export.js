'use strict';
// export.js —— CSV 导出 API：GET /v1/export/{blueprints,users,failures,installs}。
// 复用 stats.js 的 parseRange（本地日 from/to、含端点、缺省近30天）与 db.js 的只读 DAO；
// 序列化走 csv.js（中文表头 + UTF-8 BOM）。数值列导原始整数，格式化交给 Excel。

const express = require('express');
const { parseRange } = require('./stats');
const { localDay } = require('./time-utils');
const { toCsv } = require('./csv');

// 失败事件导出安全上限：避免超大范围一次性拉全表 events；命中即 log 提示截断
const EXPORT_FAIL_MAX = 100000;

// ---- 列定义（header 中文，key 取自 DAO 行；map 用于计算/拍平 payload） ----

const COLS_BLUEPRINTS = [
  { key: 'blueprintId', header: '工作流' },
  { key: 'runs', header: '运行' },
  { key: 'runsDone', header: '成功' },
  { key: 'runsFailed', header: '失败run' },
  { key: 'runsHalted', header: '中止' },
  { key: 'failures', header: '失败事件' },
  { key: 'activeMs', header: '活跃时长ms' },
  { key: 'interruptions', header: '中断' },
  { key: 'inTokens', header: '输入Token' },
  { key: 'outTokens', header: '输出Token' },
  { key: 'tokens', header: 'Token合计' },
];

const COLS_USERS = [
  { key: 'user', header: '用户' },
  { key: 'host', header: '主机' },
  { key: 'sessions', header: '会话数' },
  { key: 'runs', header: 'run数' },
  { key: 'failures', header: '失败数' },
  { key: 'sessionMs', header: '活跃时长ms' },
  { key: 'inTokens', header: '输入Token' },
  { key: 'outTokens', header: '输出Token' },
  { key: 'tokens', header: 'Token合计' },
];

const COLS_FAILURES = [
  { key: 'serverTs', header: '时间' },
  { key: 'user', header: '用户' },
  { key: 'host', header: '主机' },
  { key: 'blueprintId', header: '工作流' },
  { key: 'source', header: '来源' },
  { key: 'kind', header: '类型' },
  { key: 'reason', header: '原因' },
  { key: 'appVersion', header: '版本' },
  { key: 'eventId', header: '事件ID' },
];

const COLS_INSTALLS = [
  { key: 'user', header: '用户' },
  { key: 'host', header: '主机' },
  { key: 'appVersion', header: '版本' },
  { key: 'platform', header: '平台' },
  { key: 'channel', header: '渠道' },
  { key: 'liveSessions', header: '活动会话' },
  { key: 'lastSeen', header: '最后在线' },
  { key: 'firstSeen', header: '首次上线' },
  { key: 'installId', header: '实例ID' },
];

function createExportRouter(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const router = express.Router();

  // 路由级 try/catch 收口：任何异常 → 500，不裸崩（镜像 stats.js）
  function handle(fn) {
    return (req, res) => {
      try { fn(req, res); } catch (e) {
        console.log('[export] error:', e.message);
        res.status(500).json({ ok: false, error: 'export failed' });
      }
    };
  }

  function rangeOr400(req, res) {
    const r = parseRange(req.query, nowFn());
    if (!r) res.status(400).json({ ok: false, error: 'bad range' });
    return r;
  }

  // 统一下载响应：先设 Content-Type（res.send 不再覆盖），attachment 触发浏览器下载
  function sendCsv(res, filename, columns, rows) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv(columns, rows));
  }

  router.get('/export/blueprints', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    const rows = dao.qBlueprints(r.from, r.to).map((b) => ({
      ...b, runs: b.runsDone + b.runsFailed + b.runsHalted, tokens: b.inTokens + b.outTokens,
    }));
    sendCsv(res, `cancong-ops-blueprints-${r.from}_${r.to}.csv`, COLS_BLUEPRINTS, rows);
  }));

  router.get('/export/users', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    sendCsv(res, `cancong-ops-users-${r.from}_${r.to}.csv`, COLS_USERS, dao.qUsersAll(r.from, r.to));
  }));

  router.get('/export/failures', handle((req, res) => {
    const r = rangeOr400(req, res);
    if (!r) return;
    const raw = dao.qRecentFailures(r.from, r.to, EXPORT_FAIL_MAX);
    if (raw.length >= EXPORT_FAIL_MAX) {
      console.log('[export] failures 命中上限', EXPORT_FAIL_MAX, '范围', r.from, r.to, '导出可能被截断');
    }
    // 拍平 payload（source/kind/reason/blueprintId）；坏 payload 原样置 {}，与 stats.js 同容错
    const rows = raw.map((x) => {
      let p = {};
      try { p = JSON.parse(x.payload) || {}; } catch (_) { /* 坏 payload → 空对象 */ }
      return {
        serverTs: x.serverTs, user: x.user, host: x.host,
        blueprintId: p.blueprintId, source: p.source, kind: p.kind, reason: p.reason,
        appVersion: x.appVersion, eventId: x.eventId,
      };
    });
    sendCsv(res, `cancong-ops-failures-${r.from}_${r.to}.csv`, COLS_FAILURES, rows);
  }));

  router.get('/export/installs', handle((req, res) => {
    const today = localDay(nowFn());
    sendCsv(res, `cancong-ops-installs-${today}.csv`, COLS_INSTALLS, dao.qInstalls());
  }));

  return router;
}

module.exports = { createExportRouter };

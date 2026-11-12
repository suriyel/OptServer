'use strict';
// internal.js —— GET /v1/internal/persons：给同机 cancong-evolve 的人员同步用（TechDemos docs/REQ-FLOW-DESIGN.md §8.2）。
// 全量 installs（含 welink_uid / last_seen），聚合与在线判定在 evolve 侧做。
// 门禁白名单放行（evolve 是服务进程，没有看板会话），这里自己把关：只认回环来源，
// 或带对 OPS_INTERNAL_TOKEN（非回环部署时用）。★ 不信 X-Forwarded-For：本服务前面没有反代。

const crypto = require('crypto');
const express = require('express');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function tokenOk(want, got) {
  if (!want || typeof got !== 'string') return false;
  const a = Buffer.from(got); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createInternalRouter(dao, opts) {
  const token = (opts && opts.token != null ? opts.token : process.env.OPS_INTERNAL_TOKEN) || '';
  const remoteOf = (opts && opts.remoteOf) || ((req) => req.socket && req.socket.remoteAddress);
  const router = express.Router();
  router.get('/internal/persons', (req, res) => {
    if (!LOOPBACK.has(String(remoteOf(req) || '')) && !tokenOk(token, req.headers['x-ops-internal-token'])) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    res.json({ ok: true, data: dao.qInstalls().map((i) => ({ installId: i.installId, user: i.user, host: i.host,
      welinkUid: i.welinkUid || null, lastSeen: i.lastSeen, appVersion: i.appVersion })) });
  });
  return router;
}

module.exports = { createInternalRouter };

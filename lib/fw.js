'use strict';
// fw.js —— 框架问题看板接口（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §6.3）：
//   GET  /v1/fw-issues              登录可读：签名排名（回归置顶）
//   POST /v1/fw-issues/:sig/fixed   requireAdmin：标「已修复于 vX」（空 = 取消标记）；之后 ≥ vX 的客户端再报同签名 ⇒ 回归
// 拆分前住在自进化中心 /v1/evolve/fw-issues；审计表随自进化中心迁走，这里只打一行日志。

const express = require('express');
const { requireAdmin } = require('./auth');
const { parse3 } = require('./update');

function createFwRouter(dao) {
  const router = express.Router();
  router.get('/fw-issues', (req, res) => res.json({ ok: true, data: dao.fwList(req.query.limit, req.query.offset) }));
  router.post('/fw-issues/:sig/fixed', requireAdmin, (req, res) => {
    const v = req.body && req.body.version != null ? String(req.body.version).trim() : '';
    if (v && !parse3(v)) return res.status(400).json({ ok: false, error: 'version must be x.y.z' });
    const sig = String(req.params.sig);
    if (!dao.fwSetFixed(sig, v || null)) return res.status(404).json({ ok: false, error: 'not found' });
    console.log('[fw] ' + ((req.account && req.account.username) || '?') + ' 标记 ' + sig + ' 已修复于 ' + (v || '（取消）'));
    res.json({ ok: true, data: { signature: sig, fixedIn: v || null } });
  });
  return router;
}

module.exports = { createFwRouter };

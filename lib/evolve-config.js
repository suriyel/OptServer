'use strict';
// 蓝图自进化上报配置（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §4.1，批 3）：
//   GET /v1/config/evolve —— 客户端拉取（免登录，与 POST /v1/events 同档：内网即信任，见 lib/auth.js 白名单）
//   PUT /v1/config/evolve —— 管理员改（requireAdmin）；批 4 的配置页直接复用这份存储
// 存 meta 表单键 evolve_config（JSON），零 DDL。缺省 = 白名单空、留出 0.1、version 0。
// ★ 客户端拉不到 / 缓存过 24h 一律按空白名单 ⇒ 这里返回什么都只影响「能报什么」，不影响客户端稳定性。

const express = require('express');
const { requireAdmin } = require('./auth');

const META_KEY = 'evolve_config';
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_IDS = 500;
const DEFAULT = Object.freeze({ uploadWhitelist: [], holdoutP: 0.1, version: 0 });

function readConfig(dao) {
  try {
    const raw = dao.metaGet(META_KEY);
    if (!raw) return Object.assign({}, DEFAULT);
    const c = JSON.parse(raw);
    return {
      uploadWhitelist: Array.isArray(c.uploadWhitelist) ? c.uploadWhitelist : [],
      holdoutP: Number.isFinite(c.holdoutP) ? c.holdoutP : DEFAULT.holdoutP,
      version: Number.isFinite(c.version) ? c.version : 0,
      updatedAt: c.updatedAt || null, updatedBy: c.updatedBy || null,
    };
  } catch (_) { return Object.assign({}, DEFAULT); }
}

// → { ok, value } | { ok:false, error }
function validate(body) {
  const b = body || {};
  if (!Array.isArray(b.uploadWhitelist)) return { ok: false, error: 'uploadWhitelist must be an array' };
  if (b.uploadWhitelist.length > MAX_IDS) return { ok: false, error: 'uploadWhitelist too long' };
  if (!b.uploadWhitelist.every((x) => typeof x === 'string' && ID_RE.test(x))) return { ok: false, error: 'bad blueprint id' };
  const p = b.holdoutP === undefined ? DEFAULT.holdoutP : Number(b.holdoutP);
  if (!Number.isFinite(p) || p < 0 || p > 0.5) return { ok: false, error: 'holdoutP must be within 0..0.5' };
  return { ok: true, value: { uploadWhitelist: [...new Set(b.uploadWhitelist)], holdoutP: p } };
}

function createEvolveConfigRouter(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const router = express.Router();

  router.get('/config/evolve', (req, res) => {
    const c = readConfig(dao);
    res.json({ ok: true, uploadWhitelist: c.uploadWhitelist, holdoutP: c.holdoutP, version: c.version });
  });

  router.put('/config/evolve', requireAdmin, (req, res) => {
    const v = validate(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const prev = readConfig(dao);
    const next = Object.assign({}, v.value, {
      version: prev.version + 1, updatedAt: nowFn().toISOString(),
      updatedBy: (req.account && req.account.username) || null,
    });
    dao.metaSet(META_KEY, JSON.stringify(next));
    res.json({ ok: true, uploadWhitelist: next.uploadWhitelist, holdoutP: next.holdoutP, version: next.version });
  });

  return router;
}

module.exports = { createEvolveConfigRouter, readConfig, validate, META_KEY };

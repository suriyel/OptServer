'use strict';
// 蓝图自进化上报配置（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §4.1，批 3；§5.5 配置页签，批 4）：
//   GET /v1/config/evolve —— 客户端拉取（免登录，与 POST /v1/events 同档：内网即信任，见 lib/auth.js 白名单）。
//     ★ 响应形状是客户端契约（TechDemos server-telemetry/evolve-config.js），**只出客户端要的三项**，批 4 加的中心字段不外露。
//   PUT /v1/config/evolve —— 管理员改（requireAdmin）；每次写一行 evolve_audit（谁 / 何时 / 改前改后）。
//   GET /v1/evolve/config —— 管理员读全量（含批处理窗口、目标市场）+ 审计分页，配置页签用。
// 存 meta 表单键 evolve_config（JSON），零 DDL。缺省 = 白名单空、留出 0.1、version 0、窗口 02:00、市场 null。
// ★ 客户端拉不到 / 缓存过 24h 一律按空白名单 ⇒ 这里返回什么都只影响「能报什么」，不影响客户端稳定性。
// market = null ⇒ 用同机蚕丛登记的第一个市场（首启种子即官方市场，正合设计「默认官方」）。

const express = require('express');
const { requireAdmin } = require('./auth');

const META_KEY = 'evolve_config';
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_IDS = 500;
const DEFAULT = Object.freeze({ uploadWhitelist: [], holdoutP: 0.1, version: 0, windowHour: 2, market: null });

function readConfig(dao) {
  try {
    const raw = dao.metaGet(META_KEY);
    if (!raw) return Object.assign({}, DEFAULT);
    const c = JSON.parse(raw);
    return {
      uploadWhitelist: Array.isArray(c.uploadWhitelist) ? c.uploadWhitelist : [],
      holdoutP: Number.isFinite(c.holdoutP) ? c.holdoutP : DEFAULT.holdoutP,
      version: Number.isFinite(c.version) ? c.version : 0,
      windowHour: Number.isInteger(c.windowHour) ? c.windowHour : DEFAULT.windowHour,
      market: c.market && typeof c.market === 'object' ? c.market : null,
      updatedAt: c.updatedAt || null, updatedBy: c.updatedBy || null,
    };
  } catch (_) { return Object.assign({}, DEFAULT); }
}

function validMarket(m) {
  if (m === null) return true;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 128) return false;
  if (typeof m.url !== 'string' || !m.url.trim() || m.url.length > 512) return false;
  if (m.ref != null && (typeof m.ref !== 'string' || m.ref.length > 128)) return false;
  return true;
}

// prev：省略的批 4 字段沿用旧值（批 3 的调用方只发白名单 + p）
function validate(body, prev) {
  const b = body || {};
  const old = prev || DEFAULT;
  if (!Array.isArray(b.uploadWhitelist)) return { ok: false, error: 'uploadWhitelist must be an array' };
  if (b.uploadWhitelist.length > MAX_IDS) return { ok: false, error: 'uploadWhitelist too long' };
  if (!b.uploadWhitelist.every((x) => typeof x === 'string' && ID_RE.test(x))) return { ok: false, error: 'bad blueprint id' };
  const p = b.holdoutP === undefined ? DEFAULT.holdoutP : Number(b.holdoutP);
  if (!Number.isFinite(p) || p < 0 || p > 0.5) return { ok: false, error: 'holdoutP must be within 0..0.5' };
  const wh = b.windowHour === undefined ? old.windowHour : Number(b.windowHour);
  if (!Number.isInteger(wh) || wh < 0 || wh > 23) return { ok: false, error: 'windowHour must be an integer within 0..23' };
  const market = b.market === undefined ? old.market : b.market;
  if (!validMarket(market)) return { ok: false, error: 'market must be null or {name, url, ref?}' };
  return { ok: true, value: {
    uploadWhitelist: [...new Set(b.uploadWhitelist)], holdoutP: p, windowHour: wh,
    market: market ? { name: market.name.trim(), url: market.url.trim(), ...(market.ref ? { ref: market.ref } : {}) } : null,
  } };
}

const pick = (c) => ({ uploadWhitelist: c.uploadWhitelist, holdoutP: c.holdoutP, windowHour: c.windowHour, market: c.market });

function createEvolveConfigRouter(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const router = express.Router();

  router.get('/config/evolve', (req, res) => {
    const c = readConfig(dao);
    res.json({ ok: true, uploadWhitelist: c.uploadWhitelist, holdoutP: c.holdoutP, version: c.version });
  });

  router.put('/config/evolve', requireAdmin, (req, res) => {
    const prev = readConfig(dao);
    const v = validate(req.body, prev);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const user = (req.account && req.account.username) || null;
    const ts = nowFn().toISOString();
    const next = Object.assign({}, v.value, { version: prev.version + 1, updatedAt: ts, updatedBy: user });
    dao.metaSet(META_KEY, JSON.stringify(next));
    dao.evoAudit({ ts, user, action: 'config', target: 'v' + next.version, detail: { before: pick(prev), after: pick(next) } });
    res.json({ ok: true, uploadWhitelist: next.uploadWhitelist, holdoutP: next.holdoutP, version: next.version });
  });

  router.get('/evolve/config', requireAdmin, (req, res) => {
    const c = readConfig(dao);
    res.json({ ok: true, data: { config: c, audit: dao.evoAuditList(req.query.limit, req.query.offset) } });
  });
  return router;
}

module.exports = { createEvolveConfigRouter, readConfig, validate, META_KEY };

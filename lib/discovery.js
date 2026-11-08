'use strict';
// discovery.js —— GET /v1/discovery 服务发现（免登录；TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §4.2 C1）。
// 客户端问「自进化服务在哪」，看板据此决定是否挂「自进化」页签。env OPS_EVOLVE 三种取值：
//   ':5901'            同主机相对（共部署推荐）⇒ { evolve: { port: 5901 } }：客户端用自己连上本服务的主机名 + 端口，
//                      看板用 location.hostname + 端口 ⇒ 中心两地两 IP 天然成立
//   'http://h:5901'    绝对 URL（自进化在另一台机器）⇒ { evolve: { url } }：只供客户端上报，看板不挂页签（跨主机 Cookie 带不过去）
//   未设 / 空          明确「这里没有自进化」⇒ { evolve: null }：看板不出页签，客户端也不走约定兜底
// services 是映射：以后再拆服务只加键（只增）。

const express = require('express');

function parseEvolve(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return null;
  const m = /^:(\d{1,5})$/.exec(v);
  if (m) { const port = Number(m[1]); return port > 0 && port < 65536 ? { port } : null; }
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { url: u.origin };
  } catch (_) { return null; }
}

function createDiscoveryRouter(opts) {
  const evolve = parseEvolve(opts && opts.evolve !== undefined ? opts.evolve : process.env.OPS_EVOLVE);
  const raw = opts && opts.evolve !== undefined ? opts.evolve : process.env.OPS_EVOLVE;
  if (raw && !evolve) console.log('[discovery] OPS_EVOLVE 无法解析（' + raw + '），按「未共部署自进化」处理');
  const router = express.Router();
  router.get('/discovery', (req, res) => res.json({ schemaVersion: 1, services: { evolve } }));
  return router;
}

module.exports = { createDiscoveryRouter, parseEvolve };

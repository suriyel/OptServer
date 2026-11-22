'use strict';
// internal.js —— GET /v1/internal/persons：给 cancong-evolve 的人员同步用（TechDemos docs/REQ-FLOW-DESIGN.md §8.2）。
// 全量 installs（含 welink_uid / last_seen），聚合与在线判定在 evolve 侧做。
// 门禁白名单放行（evolve 是服务进程，没有看板会话），这里自己把关，三种来源放行：
//   · 回环（同机共部署）；
//   · OPS_EVOLVE 指向的那台机器（不同机部署：自进化服务那边只填本服务地址，两边不用再配密钥）——
//     主机名在建路由时解析一次，之后被拒时若距上次解析超过 60 s 就重解析一次再判；
//   · 带对 OPS_INTERNAL_TOKEN（老办法，留作兜底：自进化机出口地址与 OPS_EVOLVE 不一致时用）。
// 拒绝时回包带 remote = 本服务看到的来源地址，自进化那边原样显示，一眼看出是哪台机器、地址对不对得上。
// ★ 不信 X-Forwarded-For：本服务前面没有反代。

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const express = require('express');
const { parseEvolve } = require('./discovery');

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const RERESOLVE_MS = 60 * 1000;

/** '::ffff:10.1.2.3' → '10.1.2.3'；IPv6 统一小写 */
function normIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  return m ? m[1] : s;
}

function tokenOk(want, got) {
  if (!want || typeof got !== 'string') return false;
  const a = Buffer.from(got); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** OPS_EVOLVE 的原始值 ⇒ 要放行的主机（IP 或主机名）；同主机相对端口 / 没设 / 解析不了 ⇒ null（只认回环） */
function evolveHost(raw) {
  const e = parseEvolve(raw);
  if (!e || !e.url) return null;
  const h = new URL(e.url).hostname.replace(/^\[|\]$/g, '');
  return h || null;
}

/**
 * 放行 OPS_EVOLVE 主机的判定器。lookup 形同 dns.lookup(host, { all:true }, cb)，单测注入。
 * → { allows(ip) => Promise<boolean>, host, ips() }
 */
function createEvolveAllow(raw, opts) {
  const host = evolveHost(raw);
  const lookup = (opts && opts.lookup) || dns.lookup;
  const nowFn = (opts && opts.nowFn) || Date.now;
  let ips = new Set();
  let resolvedAt = 0;
  let pending = null;

  function resolve() {
    if (!host) return Promise.resolve();
    if (net.isIP(host)) { ips = new Set([normIp(host)]); resolvedAt = nowFn(); return Promise.resolve(); }
    if (pending) return pending;
    const p = new Promise((done) => {
      lookup(host, { all: true }, (err, list) => {
        resolvedAt = nowFn();
        if (err) console.log('[internal] 解析 OPS_EVOLVE 主机 ' + host + ' 失败：' + (err.code || err.message) + '（先只认回环与共享密钥）');
        else ips = new Set((list || []).map((x) => normIp(x.address)));
        done();
      });
    }).finally(() => { if (pending === p) pending = null; });   // 在 then 里清：lookup 同步回调时也清得掉
    pending = p;
    return p;
  }

  const ready = resolve().then(() => {
    if (host) console.log('[internal] 人员接口放行 OPS_EVOLVE 主机 ' + host + (ips.size ? '（' + [...ips].join(', ') + '）' : ''));
  });

  async function allows(ip) {
    if (!host) return false;
    await ready;
    if (ips.has(ip)) return true;
    if (net.isIP(host) || nowFn() - resolvedAt < RERESOLVE_MS) return false;
    await resolve();   // 自进化机换了 IP / 启动时 DNS 还没好：被拒前重解析一次
    return ips.has(ip);
  }

  return { allows, host, ips: () => [...ips] };
}

function createInternalRouter(dao, opts) {
  const o = opts || {};
  const token = (o.token != null ? o.token : process.env.OPS_INTERNAL_TOKEN) || '';
  const remoteOf = o.remoteOf || ((req) => req.socket && req.socket.remoteAddress);
  const evolve = createEvolveAllow(o.evolve !== undefined ? o.evolve : process.env.OPS_EVOLVE, { lookup: o.lookup, nowFn: o.nowMs });
  const router = express.Router();
  router.get('/internal/persons', async (req, res) => {
    const ip = normIp(remoteOf(req));
    const pass = LOOPBACK.has(ip) || tokenOk(token, req.headers['x-ops-internal-token']) || await evolve.allows(ip);
    if (!pass) return res.status(403).json({ ok: false, error: 'forbidden', remote: ip || null });
    res.json({ ok: true, data: dao.qInstalls().map((i) => ({ installId: i.installId, user: i.user, host: i.host,
      welinkUid: i.welinkUid || null, lastSeen: i.lastSeen, appVersion: i.appVersion })) });
  });
  return router;
}

module.exports = { createInternalRouter, createEvolveAllow, normIp };

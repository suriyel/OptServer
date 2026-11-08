'use strict';
// evolve-center.js —— 自进化中心看板接口（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §5.5 五页签）。
// 读口：登录即可（门禁内）；写口（裁决 / 标记修复 / 立即处理 / 推送 / 导出）：requireAdmin + 审计。
// 响应一律 { ok, data }（前端 core/api.js getStats 直接吃）；列表分页、不取大列（S4/S5）。

const express = require('express');
const { requireAdmin } = require('./auth');
const { parseRange } = require('./stats');
const { parse3 } = require('./update');

const MIN_ARM_N = 30;   // 留出对照：任一臂样本 < 30 ⇒ 不给结论
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

// 簇裁决的合法迁移（pushed 终态不可再动）
const TRANSITIONS = {
  adopt: { from: ['open', 'parked'], to: 'adopted' },
  reject: { from: ['open', 'parked', 'adopted'], to: 'rejected' },
  park: { from: ['open', 'adopted'], to: 'parked' },
  reopen: { from: ['rejected', 'parked', 'adopted'], to: 'open' },
};

/** 注入 vs 留出：首轮通过率差值的 95% 置信区间（两比例差，正态近似） */
function holdoutCompare(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.bpId + '\u0000' + r.nodeId;
    if (!by.has(k)) by.set(k, { bpId: r.bpId, nodeId: r.nodeId, inj: null, hold: null });
    by.get(k)[r.arm] = { n: r.n, firstPass: r.firstPass, rewinds: r.rewinds };
  }
  const arm = (a) => {
    const x = a || { n: 0, firstPass: 0, rewinds: 0 };
    return { n: x.n, passRate: x.n ? x.firstPass / x.n : null, avgRewinds: x.n ? x.rewinds / x.n : null };
  };
  return [...by.values()].map((g) => {
    const inj = arm(g.inj); const hold = arm(g.hold);
    const out = { bpId: g.bpId, nodeId: g.nodeId, inj, hold, diff: null, ci: null, verdict: 'insufficient' };
    if (inj.n < MIN_ARM_N || hold.n < MIN_ARM_N) return out;
    const d = inj.passRate - hold.passRate;
    const se = Math.sqrt(inj.passRate * (1 - inj.passRate) / inj.n + hold.passRate * (1 - hold.passRate) / hold.n);
    out.diff = d; out.ci = [d - 1.96 * se, d + 1.96 * se];
    out.verdict = out.ci[0] > 0 ? 'helps' : (out.ci[1] < 0 ? 'hurts' : 'inconclusive');
    return out;
  });
}

function createEvolveCenterRouter(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const runner = opts && opts.runner;
  const basket = opts && opts.basket;
  const health = opts && opts.health;   // 执行器体检（§11.2 D2）；缺省 = 不设闸（老夹具）
  const router = express.Router();
  const userOf = (req) => (req.account && req.account.username) || null;
  const ok = (res, data) => res.json({ ok: true, data });
  const fail = (res, status, error, extra) => res.status(status).json(Object.assign({ ok: false, error }, extra || {}));

  // ---- 补丁簇 ----
  router.get('/evolve/clusters', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const bp = req.query.bp ? String(req.query.bp) : null;
    ok(res, Object.assign(dao.evoClusterList({ status, bp, limit: req.query.limit, offset: req.query.offset }),
      { basket: dao.evoBasket() }));
  });
  router.get('/evolve/clusters/:id', (req, res) => {
    const c = dao.evoCluster(Number(req.params.id));
    if (!c) return fail(res, 404, 'not found');
    ok(res, Object.assign({}, c, { samples: dao.evoClusterSamples(c.id, 5) }));
  });
  router.post('/evolve/clusters/:id/:action', requireAdmin, (req, res) => {
    const t = TRANSITIONS[req.params.action];
    if (!t) return fail(res, 404, 'not found');
    const c = dao.evoCluster(Number(req.params.id));
    if (!c) return fail(res, 404, 'not found');
    if (!t.from.includes(c.status)) return fail(res, 409, 'cannot ' + req.params.action + ' a ' + c.status + ' cluster');
    const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
    if (req.params.action === 'reject' && !reason) return fail(res, 400, 'reason required');
    const ts = nowFn().toISOString();
    dao.evoSetClusterStatus(c.id, t.to, reason || null, ts);
    dao.evoAudit({ ts, user: userOf(req), action: 'cluster-' + req.params.action, target: String(c.id),
      detail: { bpId: c.bpId, from: c.status, to: t.to, reason: reason || null } });
    ok(res, { id: c.id, status: t.to });
  });

  // ---- 框架问题 ----
  router.get('/evolve/fw-issues', (req, res) => ok(res, dao.evoFwList(req.query.limit, req.query.offset)));
  router.post('/evolve/fw-issues/:sig/fixed', requireAdmin, (req, res) => {
    const v = req.body && req.body.version != null ? String(req.body.version).trim() : '';
    if (v && !parse3(v)) return fail(res, 400, 'version must be x.y.z');
    const sig = String(req.params.sig);
    if (!dao.evoFwSetFixed(sig, v || null)) return fail(res, 404, 'not found');
    const ts = nowFn().toISOString();
    dao.evoAudit({ ts, user: userOf(req), action: 'fw-fixed', target: sig, detail: { version: v || null } });
    ok(res, { signature: sig, fixedIn: v || null });
  });

  // ---- 留出对照 ----
  router.get('/evolve/holdout', (req, res) => {
    const r = parseRange(req.query, nowFn());
    if (!r) return fail(res, 400, 'bad range');
    ok(res, { from: r.from, to: r.to, minArmN: MIN_ARM_N, rows: holdoutCompare(dao.evoHoldout(r.from, r.to)) });
  });

  // ---- 执行器体检（§11.2 D2）----
  router.get('/evolve/health', async (req, res) => {
    if (!health) return ok(res, null);
    ok(res, await health.check());
  });
  router.post('/evolve/health/refresh', requireAdmin, async (req, res) => {
    if (!health) return ok(res, null);
    ok(res, await health.check({ force: true }));
  });
  // 红灯拦写：canRun 管「立即处理」，canPush 管推送 / 导出；附 items 让前端直接画出原因
  const gate = async (res, key) => {
    if (!health) return true;
    const h = await health.check();
    if (h[key]) return true;
    fail(res, 409, '执行器体检未过：' + h.items.filter((x) => x.level === 'red').map((x) => x.msg).join('；'), { code: 'executor_unhealthy', items: h.items });
    return false;
  };

  // ---- 队列 ----
  router.get('/evolve/queue', (req, res) => {
    ok(res, Object.assign(dao.evoBatchList(req.query.limit, req.query.offset), {
      queued: dao.evoQueuedCount(), failed: dao.evoFailedCount(),
      running: !!(runner && runner.isRunning()), configured: !!runner,
    }));
  });
  router.post('/evolve/queue/run', requireAdmin, async (req, res) => {
    if (!runner) return fail(res, 503, 'runner not configured');
    if (runner.isRunning()) return fail(res, 409, 'busy');
    if (!(await gate(res, 'canRun'))) return;
    dao.evoAudit({ ts: nowFn().toISOString(), user: userOf(req), action: 'queue-run', target: null, detail: null });
    runner.processQueue({ trigger: 'manual' }).catch((e) => console.log('[evolve-center] queue error:', e && e.message));
    res.status(202).json({ ok: true, data: { started: true } });
  });
  router.post('/evolve/queue/requeue', requireAdmin, (req, res) => {
    const bp = req.body && req.body.bpId ? String(req.body.bpId) : null;
    if (bp && !ID_RE.test(bp)) return fail(res, 400, 'bad blueprint id');
    const n = dao.evoRequeueFailed(bp);
    dao.evoAudit({ ts: nowFn().toISOString(), user: userOf(req), action: 'requeue', target: bp, detail: { samples: n } });
    ok(res, { requeued: n });
  });

  // ---- 篮子：推送 / 导出 ----
  router.post('/evolve/push/:bpId', requireAdmin, async (req, res) => {
    const bp = String(req.params.bpId);
    if (!ID_RE.test(bp)) return fail(res, 400, 'bad blueprint id');
    if (!basket) return fail(res, 503, 'runner not configured');
    if (!(await gate(res, 'canPush'))) return;
    try {
      const r = await basket.push(bp, userOf(req));
      if (!r.ok) return fail(res, r.status || 409, r.error, { code: r.code, failed: r.failed });
      ok(res, r);
    } catch (e) {
      fail(res, 502, String(e && e.message), { code: e && e.code });
    }
  });
  router.get('/evolve/export/:bpId', requireAdmin, async (req, res) => {
    const bp = String(req.params.bpId);
    if (!ID_RE.test(bp)) return fail(res, 400, 'bad blueprint id');
    if (!basket) return fail(res, 503, 'runner not configured');
    if (!(await gate(res, 'canPush'))) return;
    try {
      const r = await basket.exportPatch(bp, userOf(req));
      if (!r.ok) return fail(res, r.status || 409, r.error, { code: r.code });
      res.set('Content-Type', 'text/x-patch; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="' + bp + '-evolve.patch"');
      res.send(r.text);
    } catch (e) {
      fail(res, 502, String(e && e.message), { code: e && e.code });
    }
  });

  router.get('/evolve/audit', requireAdmin, (req, res) => ok(res, dao.evoAuditList(req.query.limit, req.query.offset)));
  return router;
}

module.exports = { createEvolveCenterRouter, holdoutCompare, TRANSITIONS, MIN_ARM_N };

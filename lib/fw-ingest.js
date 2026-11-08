'use strict';
// fw-ingest.js —— framework_issue 入库（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §6.3；原 lib/evolve-ingest.js 的框架问题分支）。
// 由 ingest.js 在**幂等门之后、同一事务内**调用 ⇒ spool 重发批不会双计。
// 框架问题归本服务（设计稿 Q4：只有框架维护者修框架）；客户端固定把它发一份到中心遥测，另一份发自进化服务（只读展示）。
// 机器数走 fw_issue_machines（v7 起；不再写 evolve_samples）。

const { cmp3 } = require('./update');

const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max || 256));

function ingestFrameworkIssue(dao, ev, ts) {
  const p = ev.payload || {};
  const signature = str(p.signature, 128);
  if (!signature) return;
  const appVersion = str(ev.appVersion, 64);
  const n = Number(p.count);
  dao.fwUpsert({
    signature, category: str(p.category, 64), rule: str(p.ruleOrCode, 128), sample: str(p.sample, 1024),
    nodeId: str(p.nodeId, 128), bpId: str(p.blueprintId, 128), installId: ev.installId,
    count: Number.isFinite(n) && n > 0 ? Math.round(n) : 1,
    judged: typeof p.passedAfter === 'boolean' ? 1 : 0, passed: p.passedAfter === true ? 1 : 0, now: ts,
  });
  // 标过「已修复于 vX」且此样本来自 ≥ vX 的客户端 ⇒ 回归（只记第一次见到的版本）
  const row = dao.fwRow(signature);
  if (row && row.fixedIn && !row.regressedVersion && appVersion && cmp3(appVersion, row.fixedIn) >= 0) {
    dao.fwSetRegressed(signature, appVersion);
  }
}

module.exports = { ingestFrameworkIssue };

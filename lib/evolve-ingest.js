'use strict';
// evolve-ingest.js —— 自进化样本入库即 upsert 中心表（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §5.2 S1/S2）。
// 由 ingest.js 在**幂等门之后、同一事务内**调用 ⇒ spool 重发批不会双计。
//
// 牙齿（§8 批 4）：
// · 同签名二次入库只加计数、零 LLM —— 签名已归属某簇（不论簇状态）⇒ 样本直接挂簇置 done，不进队列。
// · 已裁决簇不再出补丁 —— 同上（入库这一半）；跑批那一半在 center/runner.js 只合成 open 簇。

const { cmp3 } = require('./update');

const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max || 256));

function ingestProposal(dao, ev, ts) {
  const p = ev.payload || {};
  const signature = str(p.signature, 128);
  const clusterId = signature ? dao.evoClusterOfSignature(signature) : null;
  dao.evoInsertSample({
    type: ev.type, signature, bpId: str(p.blueprintId, 128), nodeId: str(p.nodeId, 128),
    installId: ev.installId, runId: str(p.runId, 64), appVersion: str(ev.appVersion, 64),
    payload: JSON.stringify(p), ts,
    // 没签名的样本无法归簇也无法回指裁决 ⇒ 只存档，不进队列
    status: clusterId != null || !signature ? 'done' : 'queued', clusterId,
  });
  if (clusterId != null) dao.evoRecountCluster(clusterId, ts);
}

function ingestVerdict(dao, ev, ts) {
  const p = ev.payload || {};
  const signature = str(p.signature, 128);
  dao.evoInsertSample({
    type: ev.type, signature, bpId: signature ? dao.evoBpOfSignature(signature) : null,
    installId: ev.installId, appVersion: str(ev.appVersion, 64), payload: JSON.stringify(p), ts, status: 'done',
  });
  const clusterId = signature ? dao.evoClusterOfSignature(signature) : null;
  if (clusterId != null) dao.evoRecountCluster(clusterId, ts); // 未聚类的：挂簇时重算一并补计
}

function ingestFrameworkIssue(dao, ev, ts) {
  const p = ev.payload || {};
  const signature = str(p.signature, 128);
  if (!signature) return;
  const appVersion = str(ev.appVersion, 64);
  dao.evoInsertSample({
    type: ev.type, signature, bpId: str(p.blueprintId, 128), nodeId: str(p.nodeId, 128),
    installId: ev.installId, appVersion, payload: JSON.stringify(p), ts, status: 'done',
  });
  const n = Number(p.count);
  dao.evoUpsertFw({
    signature, category: str(p.category, 64), rule: str(p.ruleOrCode, 128), sample: str(p.sample, 1024),
    nodeId: str(p.nodeId, 128), bpId: str(p.blueprintId, 128),
    count: Number.isFinite(n) && n > 0 ? Math.round(n) : 1,
    judged: typeof p.passedAfter === 'boolean' ? 1 : 0, passed: p.passedAfter === true ? 1 : 0, now: ts,
  });
  // 标过「已修复于 vX」且此样本来自 ≥ vX 的客户端 ⇒ 回归（只记第一次见到的版本）
  const row = dao.evoFwRow(signature);
  if (row && row.fixedIn && !row.regressedVersion && appVersion && cmp3(appVersion, row.fixedIn) >= 0) {
    dao.evoFwSetRegressed(signature, appVersion);
  }
}

// bp_run_end.nodes（批 3 留出摘要）⇒ 按「蓝图 + 节点 + 臂」每日累加；injected / holdout 都为假（无可注入）不计
function ingestHoldout(dao, ev, day) {
  const p = ev.payload || {};
  const bpId = str(p.blueprintId, 128);
  if (!bpId || !Array.isArray(p.nodes)) return;
  for (const nd of p.nodes.slice(0, 50)) {
    if (!nd || typeof nd !== 'object') continue;
    const nodeId = str(nd.nodeId, 128);
    const arm = nd.holdout === true ? 'hold' : (nd.injected === true ? 'inj' : null);
    if (!nodeId || !arm) continue;
    const rw = Number(nd.rewinds);
    dao.evoBumpHoldout({ day, bpId, nodeId, arm, firstPass: nd.firstPass === true ? 1 : 0,
      rewinds: Number.isFinite(rw) && rw > 0 ? Math.round(rw) : 0 });
  }
}

function ingestEvolve(dao, ev, ts, day) {
  if (ev.type === 'bp_patch_proposal') ingestProposal(dao, ev, ts);
  else if (ev.type === 'bp_patch_verdict') ingestVerdict(dao, ev, ts);
  else if (ev.type === 'framework_issue') ingestFrameworkIssue(dao, ev, ts);
  else if (ev.type === 'bp_run_end') ingestHoldout(dao, ev, day);
}

module.exports = { ingestEvolve };

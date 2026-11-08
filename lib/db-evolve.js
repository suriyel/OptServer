'use strict';
// db-evolve.js —— 蓝图自进化「中心」的 SQL 层（v6 表 + DAO）。与 db.js 同属唯一 SQL 层
// （db.js 铁律 1 的「此文件」含本文件）；单列出来只为不把 db.js 撑得更大。
// 设计：TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §5.2 / §6（S1–S5）。
//
// 口径：
// · 样本入库即写 evolve_samples（S1）——**不从 90 天 events 原始表回读**。
// · 簇计数在入库 / 挂簇时按簇**整行重算**（runs = 去重 run 数、machines = 去重实例数、applied/rejected =
//   回指本簇提案签名的裁决数），而不是逐条 +1：裁决可能先于聚类到达，重算天然补齐，无「漏加一次」的漂移。
// · 列表查询一律不取大列（payload / synth_text，S5）。

const DDL_V6 = `
CREATE TABLE evolve_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, signature TEXT, bp_id TEXT, node_id TEXT,
  install_id TEXT, run_id TEXT, app_version TEXT, payload TEXT,
  status TEXT NOT NULL DEFAULT 'done',            -- queued | batched | done | failed
  cluster_id INTEGER, batch_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0, ts TEXT
);
CREATE INDEX ix_evs_bp_status ON evolve_samples(bp_id, status);
CREATE INDEX ix_evs_signature ON evolve_samples(signature);
CREATE INDEX ix_evs_cluster ON evolve_samples(cluster_id);
CREATE INDEX ix_evs_batch ON evolve_samples(batch_id);

CREATE TABLE evolve_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bp_id TEXT NOT NULL, node_id TEXT, title TEXT,
  status TEXT NOT NULL DEFAULT 'open',             -- open | adopted | rejected | parked | pushed
  runs INTEGER NOT NULL DEFAULT 0, machines INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
  synth_text TEXT, synth_summary TEXT, base_version TEXT,
  review_pass INTEGER, review_flags TEXT, review_notes TEXT,
  resynth INTEGER NOT NULL DEFAULT 0, reason TEXT, branch TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX ix_evc_bp_status ON evolve_clusters(bp_id, status);

CREATE TABLE fw_issues (
  signature TEXT PRIMARY KEY,
  category TEXT, rule TEXT, sample TEXT, node_id TEXT, bp_id TEXT,
  count INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0,
  judged INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0,
  machines INTEGER NOT NULL DEFAULT 0,
  fixed_in TEXT, regressed_version TEXT, first_at TEXT, last_at TEXT
);
CREATE INDEX ix_fw_count ON fw_issues(count);

CREATE TABLE evolve_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bp_id TEXT, status TEXT NOT NULL,                -- running | done | failed
  samples INTEGER NOT NULL DEFAULT 0, new_clusters INTEGER NOT NULL DEFAULT 0,
  synthesized INTEGER NOT NULL DEFAULT 0,
  run_id TEXT, cwd TEXT, trigger TEXT, error TEXT, started_at TEXT, ended_at TEXT
);

CREATE TABLE evolve_holdout (
  day TEXT, bp_id TEXT, node_id TEXT, arm TEXT,    -- arm: inj | hold
  n INTEGER NOT NULL DEFAULT 0, first_pass INTEGER NOT NULL DEFAULT 0, rewinds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bp_id, node_id, arm)
);

CREATE TABLE evolve_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT, user TEXT, action TEXT, target TEXT, detail TEXT
);
`;

// 列表列（不含大列 synth_text / review_notes）
const CLUSTER_COLS = `id, bp_id AS bpId, node_id AS nodeId, title, status, runs, machines, applied, rejected,
  synth_summary AS synthSummary, base_version AS baseVersion, review_pass AS reviewPass,
  review_flags AS reviewFlags, resynth, reason, branch, created_at AS createdAt, updated_at AS updatedAt`;

function makeEvolveDao(db) {
  const stInsertSample = db.prepare(`
    INSERT INTO evolve_samples (type, signature, bp_id, node_id, install_id, run_id, app_version, payload, status, cluster_id, ts)
    VALUES (@type, @signature, @bpId, @nodeId, @installId, @runId, @appVersion, @payload, @status, @clusterId, @ts)`);
  // 签名 → 已归属的簇（任一状态）：只看提案样本
  const stClusterOfSig = db.prepare(`
    SELECT cluster_id AS c FROM evolve_samples
    WHERE signature = ? AND type = 'bp_patch_proposal' AND cluster_id IS NOT NULL LIMIT 1`);
  const stBpOfSig = db.prepare(`
    SELECT bp_id AS b FROM evolve_samples WHERE signature = ? AND type = 'bp_patch_proposal' LIMIT 1`);
  const stRecountCluster = db.prepare(`
    UPDATE evolve_clusters SET
      runs = (SELECT COUNT(DISTINCT COALESCE(run_id, id)) FROM evolve_samples WHERE cluster_id = @id AND type = 'bp_patch_proposal'),
      machines = (SELECT COUNT(DISTINCT install_id) FROM evolve_samples WHERE cluster_id = @id AND type = 'bp_patch_proposal'),
      applied = (SELECT COUNT(*) FROM evolve_samples v WHERE v.type = 'bp_patch_verdict'
                 AND json_extract(v.payload, '$.verdict') = 'applied'
                 AND v.signature IN (SELECT signature FROM evolve_samples WHERE cluster_id = @id AND type = 'bp_patch_proposal')),
      rejected = (SELECT COUNT(*) FROM evolve_samples v WHERE v.type = 'bp_patch_verdict'
                 AND json_extract(v.payload, '$.verdict') = 'rejected'
                 AND v.signature IN (SELECT signature FROM evolve_samples WHERE cluster_id = @id AND type = 'bp_patch_proposal')),
      updated_at = @now
    WHERE id = @id`);

  // ---- 框架问题 ----
  const stUpsertFw = db.prepare(`
    INSERT INTO fw_issues (signature, category, rule, sample, node_id, bp_id, count, reports, judged, passed, first_at, last_at)
    VALUES (@signature, @category, @rule, @sample, @nodeId, @bpId, @count, 1, @judged, @passed, @now, @now)
    ON CONFLICT(signature) DO UPDATE SET
      count = count + excluded.count, reports = reports + 1,
      judged = judged + excluded.judged, passed = passed + excluded.passed,
      sample = COALESCE(excluded.sample, sample), last_at = excluded.last_at`);
  const stFwMachines = db.prepare(`
    UPDATE fw_issues SET machines = (SELECT COUNT(DISTINCT install_id) FROM evolve_samples
      WHERE type = 'framework_issue' AND signature = @sig) WHERE signature = @sig`);
  const stFwRow = db.prepare(`SELECT signature, fixed_in AS fixedIn, regressed_version AS regressedVersion FROM fw_issues WHERE signature = ?`);
  const stFwSetRegressed = db.prepare(`UPDATE fw_issues SET regressed_version = ? WHERE signature = ?`);
  const stFwSetFixed = db.prepare(`UPDATE fw_issues SET fixed_in = ?, regressed_version = NULL WHERE signature = ?`);
  const stFwList = db.prepare(`
    SELECT signature, category, rule, sample, node_id AS nodeId, bp_id AS bpId, count, reports, judged, passed,
      machines, fixed_in AS fixedIn, regressed_version AS regressedVersion, first_at AS firstAt, last_at AS lastAt
    FROM fw_issues ORDER BY (regressed_version IS NOT NULL) DESC, count DESC, signature LIMIT ? OFFSET ?`);
  const stFwCount = db.prepare(`SELECT COUNT(*) AS c FROM fw_issues`);

  // ---- 留出 ----
  const stBumpHoldout = db.prepare(`
    INSERT INTO evolve_holdout (day, bp_id, node_id, arm, n, first_pass, rewinds) VALUES (@day, @bpId, @nodeId, @arm, 1, @firstPass, @rewinds)
    ON CONFLICT(day, bp_id, node_id, arm) DO UPDATE SET
      n = n + 1, first_pass = first_pass + excluded.first_pass, rewinds = rewinds + excluded.rewinds`);
  const stHoldout = db.prepare(`
    SELECT bp_id AS bpId, node_id AS nodeId, arm, SUM(n) AS n, SUM(first_pass) AS firstPass, SUM(rewinds) AS rewinds
    FROM evolve_holdout WHERE day >= ? AND day <= ? GROUP BY bp_id, node_id, arm ORDER BY bp_id, node_id, arm`);

  // ---- 队列 ----
  const stQueuedBps = db.prepare(`
    SELECT bp_id AS bpId FROM evolve_samples WHERE status = 'queued' AND type = 'bp_patch_proposal' AND bp_id IS NOT NULL
    UNION SELECT bp_id FROM evolve_clusters WHERE status = 'open' AND resynth = 1
    ORDER BY 1`);
  const stQueuedCount = db.prepare(`
    SELECT bp_id AS bpId, COUNT(*) AS n FROM evolve_samples WHERE status = 'queued' AND type = 'bp_patch_proposal'
    GROUP BY bp_id ORDER BY bp_id`);
  const stMarkBatched = db.prepare(`
    UPDATE evolve_samples SET status = 'batched', batch_id = ?
    WHERE bp_id = ? AND status = 'queued' AND type = 'bp_patch_proposal'`);
  // 每个签名一条代表（最早那条）+ 计数；流式 iterate（S5）
  const stBatchReps = db.prepare(`
    SELECT s.id, s.signature, s.node_id AS nodeId, s.payload, g.n, g.machines
    FROM (SELECT MIN(id) AS id, COUNT(*) AS n, COUNT(DISTINCT install_id) AS machines
          FROM evolve_samples WHERE batch_id = ? AND status = 'batched' GROUP BY signature) g
    JOIN evolve_samples s ON s.id = g.id ORDER BY s.id`);
  // 挂簇：同签名所有尚未挂簇的提案（含跑批期间新到的 queued 同签名）一并挂上、置 done
  const stAssignSig = db.prepare(`
    UPDATE evolve_samples SET cluster_id = @clusterId, status = 'done'
    WHERE signature = @signature AND type = 'bp_patch_proposal' AND cluster_id IS NULL`);
  // 批失败 / 批内未被分配：退回 queued（第二次再败 ⇒ failed 标红）
  const stReleaseBatch = db.prepare(`
    UPDATE evolve_samples SET attempts = attempts + 1,
      status = CASE WHEN attempts + 1 >= 2 THEN 'failed' ELSE 'queued' END
    WHERE batch_id = ? AND status = 'batched'`);
  const stClusterReps = db.prepare(`
    SELECT s.signature, s.payload FROM evolve_samples s
    WHERE s.cluster_id = ? AND s.type = 'bp_patch_proposal'
      AND s.id IN (SELECT MAX(id) FROM evolve_samples WHERE cluster_id = ? AND type = 'bp_patch_proposal' GROUP BY signature)
    ORDER BY s.id DESC LIMIT ?`);
  const stInsertBatch = db.prepare(`
    INSERT INTO evolve_batches (bp_id, status, samples, cwd, trigger, started_at) VALUES (@bpId, 'running', 0, @cwd, @trigger, @now)`);
  const stUpdateBatch = db.prepare(`
    UPDATE evolve_batches SET status = COALESCE(@status, status), samples = COALESCE(@samples, samples),
      new_clusters = COALESCE(@newClusters, new_clusters), synthesized = COALESCE(@synthesized, synthesized),
      run_id = COALESCE(@runId, run_id), error = COALESCE(@error, error), ended_at = COALESCE(@endedAt, ended_at)
    WHERE id = @id`);
  const stBatchList = db.prepare(`
    SELECT id, bp_id AS bpId, status, samples, new_clusters AS newClusters, synthesized, run_id AS runId,
      trigger, error, started_at AS startedAt, ended_at AS endedAt
    FROM evolve_batches ORDER BY id DESC LIMIT ? OFFSET ?`);
  const stBatchCount = db.prepare(`SELECT COUNT(*) AS c FROM evolve_batches`);
  const stFailedCount = db.prepare(`
    SELECT bp_id AS bpId, COUNT(*) AS n FROM evolve_samples WHERE status = 'failed' GROUP BY bp_id ORDER BY bp_id`);
  const stRequeueFailed = db.prepare(`
    UPDATE evolve_samples SET status = 'queued', attempts = 0 WHERE status = 'failed' AND (? IS NULL OR bp_id = ?)`);

  // ---- 簇 ----
  const stInsertCluster = db.prepare(`
    INSERT INTO evolve_clusters (bp_id, node_id, title, status, created_at, updated_at)
    VALUES (@bpId, @nodeId, @title, 'open', @now, @now)`);
  const stClustersOfBp = db.prepare(`SELECT ${CLUSTER_COLS} FROM evolve_clusters WHERE bp_id = ? ORDER BY id`);
  const stSetSynth = db.prepare(`
    UPDATE evolve_clusters SET synth_text = @synthText, synth_summary = @synthSummary, base_version = @baseVersion,
      review_pass = @reviewPass, review_flags = @reviewFlags, review_notes = @reviewNotes, resynth = 0, updated_at = @now
    WHERE id = @id AND status = 'open'`);
  const stSetStatus = db.prepare(`
    UPDATE evolve_clusters SET status = @status, reason = @reason, updated_at = @now WHERE id = @id`);
  const stSetResynth = db.prepare(`
    UPDATE evolve_clusters SET status = 'open', resynth = 1, reason = @reason, updated_at = @now WHERE id = @id`);
  const stSetPushed = db.prepare(`
    UPDATE evolve_clusters SET status = 'pushed', branch = @branch, updated_at = @now WHERE id = @id AND status = 'adopted'`);
  const stClusterFull = db.prepare(`
    SELECT ${CLUSTER_COLS}, synth_text AS synthText, review_notes AS reviewNotes FROM evolve_clusters WHERE id = ?`);
  const stAdopted = db.prepare(`
    SELECT ${CLUSTER_COLS}, synth_text AS synthText FROM evolve_clusters WHERE bp_id = ? AND status = 'adopted' ORDER BY id`);
  const stBasket = db.prepare(`
    SELECT bp_id AS bpId, COUNT(*) AS n FROM evolve_clusters WHERE status = 'adopted' GROUP BY bp_id ORDER BY bp_id`);
  const stClusterSamples = db.prepare(`
    SELECT id, install_id AS installId, run_id AS runId, app_version AS appVersion, ts, payload
    FROM evolve_samples WHERE cluster_id = ? AND type = 'bp_patch_proposal' ORDER BY id DESC LIMIT ?`);

  // 列表：status / bp 可选过滤（NULL = 不过滤）
  const LIST_WHERE = `WHERE (@status IS NULL OR status = @status) AND (@bp IS NULL OR bp_id = @bp)`;
  const stClusterList = db.prepare(`
    SELECT ${CLUSTER_COLS} FROM evolve_clusters ${LIST_WHERE}
    ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'adopted' THEN 1 ELSE 2 END, machines DESC, runs DESC, id DESC
    LIMIT @limit OFFSET @offset`);
  const stClusterListCount = db.prepare(`SELECT COUNT(*) AS c FROM evolve_clusters ${LIST_WHERE}`);

  // ---- 审计 ----
  const stAudit = db.prepare(`INSERT INTO evolve_audit (ts, user, action, target, detail) VALUES (?, ?, ?, ?, ?)`);
  const stAuditList = db.prepare(`
    SELECT id, ts, user, action, target, detail FROM evolve_audit ORDER BY id DESC LIMIT ? OFFSET ?`);
  const stAuditCount = db.prepare(`SELECT COUNT(*) AS c FROM evolve_audit`);

  const page = (limit, offset) => [Math.max(1, Math.min(Number(limit) || 50, 200)), Math.max(0, Number(offset) || 0)];
  const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

  return {
    // 入库
    evoInsertSample(s) {
      return Number(stInsertSample.run({
        type: s.type, signature: s.signature || null, bpId: s.bpId || null, nodeId: s.nodeId || null,
        installId: s.installId || null, runId: s.runId || null, appVersion: s.appVersion || null,
        payload: s.payload == null ? null : String(s.payload), status: s.status || 'done',
        clusterId: s.clusterId == null ? null : s.clusterId, ts: s.ts || null,
      }).lastInsertRowid);
    },
    evoClusterOfSignature(sig) { const r = sig ? stClusterOfSig.get(sig) : null; return r ? r.c : null; },
    evoBpOfSignature(sig) { const r = sig ? stBpOfSig.get(sig) : null; return r ? r.b : null; },
    evoRecountCluster(id, nowIso) { stRecountCluster.run({ id, now: nowIso }); },
    evoUpsertFw(f) {
      stUpsertFw.run({
        signature: f.signature, category: f.category || null, rule: f.rule || null, sample: f.sample || null,
        nodeId: f.nodeId || null, bpId: f.bpId || null, count: f.count, judged: f.judged, passed: f.passed, now: f.now,
      });
      stFwMachines.run({ sig: f.signature });
    },
    evoFwRow(sig) { return stFwRow.get(sig) || null; },
    evoFwSetRegressed(sig, version) { stFwSetRegressed.run(version, sig); },
    evoFwSetFixed(sig, version) { return stFwSetFixed.run(version || null, sig).changes; },
    evoFwList(limit, offset) { const [l, o] = page(limit, offset); return { rows: stFwList.all(l, o), total: stFwCount.get().c }; },
    evoBumpHoldout(h) { stBumpHoldout.run(h); },
    evoHoldout(fromDay, toDay) { return stHoldout.all(fromDay, toDay); },

    // 队列
    evoQueuedBlueprints() { return stQueuedBps.all().map((r) => r.bpId).filter(Boolean); },
    evoQueuedCount() { return stQueuedCount.all(); },
    evoFailedCount() { return stFailedCount.all(); },
    evoRequeueFailed(bpId) { const b = bpId || null; return stRequeueFailed.run(b, b).changes; },
    evoMarkBatched(bpId, batchId) { return stMarkBatched.run(batchId, bpId).changes; },
    evoIterBatchReps(batchId) { return stBatchReps.iterate(batchId); },
    evoAssignSignature(signature, clusterId) { return stAssignSig.run({ signature, clusterId }).changes; },
    evoReleaseBatch(batchId) { return stReleaseBatch.run(batchId).changes; },
    evoClusterReps(clusterId, limit) {
      return stClusterReps.all(clusterId, clusterId, limit || 5).map((r) => ({ signature: r.signature, payload: parse(r.payload) || {} }));
    },
    evoInsertBatch(b) { return Number(stInsertBatch.run({ bpId: b.bpId, cwd: b.cwd || null, trigger: b.trigger || null, now: b.now }).lastInsertRowid); },
    evoUpdateBatch(id, patch) {
      stUpdateBatch.run(Object.assign({ id, status: null, samples: null, newClusters: null, synthesized: null,
        runId: null, error: null, endedAt: null }, patch));
    },
    evoBatchList(limit, offset) { const [l, o] = page(limit, offset); return { rows: stBatchList.all(l, o), total: stBatchCount.get().c }; },

    // 簇
    evoInsertCluster(c) { return Number(stInsertCluster.run({ bpId: c.bpId, nodeId: c.nodeId || null, title: c.title || null, now: c.now }).lastInsertRowid); },
    evoClustersOfBp(bpId) { return stClustersOfBp.all(bpId); },
    evoSetSynth(id, s) {
      return stSetSynth.run({
        id, synthText: s.synthText || null, synthSummary: s.synthSummary || null, baseVersion: s.baseVersion || null,
        reviewPass: s.reviewPass == null ? null : (s.reviewPass ? 1 : 0),
        reviewFlags: s.reviewFlags && s.reviewFlags.length ? s.reviewFlags.join(',') : null,
        reviewNotes: s.reviewNotes || null, now: s.now,
      }).changes;
    },
    evoSetClusterStatus(id, status, reason, nowIso) { return stSetStatus.run({ id, status, reason: reason || null, now: nowIso }).changes; },
    evoMarkResynth(id, reason, nowIso) { return stSetResynth.run({ id, reason: reason || null, now: nowIso }).changes; },
    evoSetPushed(id, branch, nowIso) { return stSetPushed.run({ id, branch, now: nowIso }).changes; },
    evoCluster(id) { return stClusterFull.get(id) || null; },
    evoAdopted(bpId) { return stAdopted.all(bpId); },
    evoBasket() { return stBasket.all(); },
    evoClusterSamples(id, limit) {
      return stClusterSamples.all(id, Math.max(1, Math.min(Number(limit) || 5, 50)))
        .map((r) => Object.assign({}, r, { payload: parse(r.payload) || {} }));
    },
    evoClusterList(q) {
      const [l, o] = page(q && q.limit, q && q.offset);
      const p = { status: (q && q.status) || null, bp: (q && q.bp) || null };
      return { rows: stClusterList.all(Object.assign({ limit: l, offset: o }, p)), total: stClusterListCount.get(p).c };
    },
    evoTx(fn) { return db.transaction(fn); },

    // 审计
    evoAudit(a) { stAudit.run(a.ts, a.user || null, a.action, a.target == null ? null : String(a.target), a.detail == null ? null : JSON.stringify(a.detail)); },
    evoAuditList(limit, offset) {
      const [l, o] = page(limit, offset);
      return { rows: stAuditList.all(l, o).map((r) => Object.assign({}, r, { detail: parse(r.detail) })), total: stAuditCount.get().c };
    },
  };
}

module.exports = { DDL_V6, makeEvolveDao };

'use strict';
// db-fw.js —— 框架问题的 SQL 层（v7 起）+ 冻结的 v6 迁移历史。与 db.js 同属唯一 SQL 层（db.js 铁律 1）。
//
// 2026-11 自进化中心拆出为独立服务 cancong-evolve（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §6）：
// · DDL_V6（自进化六表）是**迁移历史，冻结原样**——老库要从 v5 升上来必须经过它，v7 再删掉其中五张。
// · v7：建 fw_issue_machines（框架问题机器数的新来源；原先靠 evolve_samples 去重计）→ 从 evolve_samples 回填 →
//   逐条 DROP 五张自进化表 → 删 meta 键 evolve_config。fw_issues（含已修复于 / 回归）保留，归本服务（设计稿 Q4）。
// · 启动期预编译的语句里不得再出现已删的表（否则老库升级后 makeDao 即抛）。

// ---- 冻结：v6 迁移历史（勿改）----
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

// ---- v7：拆出自进化中心（SQLite 不支持一条 DROP TABLE a, b ⇒ 逐条）----
const DDL_V7 = `
CREATE TABLE fw_issue_machines (
  signature TEXT NOT NULL, install_id TEXT NOT NULL,
  PRIMARY KEY (signature, install_id)
);
INSERT OR IGNORE INTO fw_issue_machines (signature, install_id)
  SELECT DISTINCT signature, install_id FROM evolve_samples
  WHERE type = 'framework_issue' AND signature IS NOT NULL AND install_id IS NOT NULL;
DROP TABLE IF EXISTS evolve_samples;
DROP TABLE IF EXISTS evolve_clusters;
DROP TABLE IF EXISTS evolve_batches;
DROP TABLE IF EXISTS evolve_holdout;
DROP TABLE IF EXISTS evolve_audit;
DELETE FROM meta WHERE key = 'evolve_config';
`;

function makeFwDao(db) {
  const stUpsertFw = db.prepare(`
    INSERT INTO fw_issues (signature, category, rule, sample, node_id, bp_id, count, reports, judged, passed, first_at, last_at)
    VALUES (@signature, @category, @rule, @sample, @nodeId, @bpId, @count, 1, @judged, @passed, @now, @now)
    ON CONFLICT(signature) DO UPDATE SET
      count = count + excluded.count, reports = reports + 1,
      judged = judged + excluded.judged, passed = passed + excluded.passed,
      sample = COALESCE(excluded.sample, sample), last_at = excluded.last_at`);
  const stFwMachineAdd = db.prepare(`INSERT OR IGNORE INTO fw_issue_machines (signature, install_id) VALUES (?, ?)`);
  const stFwMachines = db.prepare(`
    UPDATE fw_issues SET machines = (SELECT COUNT(*) FROM fw_issue_machines WHERE signature = @sig) WHERE signature = @sig`);
  const stFwRow = db.prepare(`SELECT signature, fixed_in AS fixedIn, regressed_version AS regressedVersion FROM fw_issues WHERE signature = ?`);
  const stFwSetRegressed = db.prepare(`UPDATE fw_issues SET regressed_version = ? WHERE signature = ?`);
  const stFwSetFixed = db.prepare(`UPDATE fw_issues SET fixed_in = ?, regressed_version = NULL WHERE signature = ?`);
  const stFwList = db.prepare(`
    SELECT signature, category, rule, sample, node_id AS nodeId, bp_id AS bpId, count, reports, judged, passed,
      machines, fixed_in AS fixedIn, regressed_version AS regressedVersion, first_at AS firstAt, last_at AS lastAt
    FROM fw_issues ORDER BY (regressed_version IS NOT NULL) DESC, count DESC, signature LIMIT ? OFFSET ?`);
  const stFwCount = db.prepare(`SELECT COUNT(*) AS c FROM fw_issues`);
  const page = (limit, offset) => [Math.max(1, Math.min(Number(limit) || 50, 200)), Math.max(0, Number(offset) || 0)];

  return {
    fwUpsert(f) {
      stUpsertFw.run({
        signature: f.signature, category: f.category || null, rule: f.rule || null, sample: f.sample || null,
        nodeId: f.nodeId || null, bpId: f.bpId || null, count: f.count, judged: f.judged, passed: f.passed, now: f.now,
      });
      if (f.installId) stFwMachineAdd.run(f.signature, f.installId);
      stFwMachines.run({ sig: f.signature });
    },
    fwRow(sig) { return stFwRow.get(sig) || null; },
    fwSetRegressed(sig, version) { stFwSetRegressed.run(version, sig); },
    fwSetFixed(sig, version) { return stFwSetFixed.run(version || null, sig).changes; },
    fwList(limit, offset) { const [l, o] = page(limit, offset); return { rows: stFwList.all(l, o), total: stFwCount.get().c }; },
  };
}

module.exports = { DDL_V6, DDL_V7, makeFwDao };

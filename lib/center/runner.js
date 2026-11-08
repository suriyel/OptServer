'use strict';
// center/runner.js —— 自进化队列处理（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §5.3 / §5.4）。
//
// 一次 processQueue：确保同机蚕丛装着中心工作流 → 按蓝图串行成批 → 每批：
//   写输入（流式，S5）→ 回环 POST /_blueprint/run（无头）→ 轮询到终态 → 读输出入库。
// 只有新签名进批（入库时已挂簇的签名零 LLM，见 evolve-ingest.js）；
// 合成只落 open 簇（已裁决簇即便被 LLM 并入新样本，也只加计数、不出补丁——§8 牙齿 2）。
// 失败：本批样本退回 queued（attempts+1），第二次再败 ⇒ failed（队列页标红，可手动重排）。
// 并发：async 单飞（running 标志），重入直接返回 busy。
// 执行器体检（§11.2 D2，opts.health）：开跑前强制体检一次，红灯 ⇒ 记一条失败批次后返回，样本不标 batched、不烧重试次数；
// 起 run 回 503（缺工具 / 无激活 profile）⇒ 本批样本原样退回 queued（attempts 不变），报给体检，本轮余下蓝图不再跑。

const fs = require('fs');
const path = require('path');
const { parseSynth, applyHunks } = require('./patch');
const { resolveBase, readSkill, decodeFile, errOf } = require('./upstream');
const { readConfig } = require('../evolve-config');

const CENTER_ID = 'evolve-center';
const DEFAULT_CENTER_DIR = path.join(__dirname, '..', '..', 'center-blueprint', CENTER_ID);
const REPS_PER_CLUSTER = 5;
const FLAG_SET = new Set(['gate-weakening', 'overfit', 'conflict']);

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
const parse = (s) => { try { return JSON.parse(s); } catch (_) { return {}; } };

// OptServer 与蚕丛可能是两个系统用户：批目录放开读写，蚕丛的 agent 才写得了 output/
function mkdirOpen(p) {
  fs.mkdirSync(p, { recursive: true });
  try { fs.chmodSync(p, 0o777); } catch (_) { /* Windows 开发机无意义 */ }
}

function createRunner(dao, client, opts) {
  opts = opts || {};
  const nowFn = opts.nowFn || (() => new Date());
  const workRoot = opts.workDir;
  const centerDir = opts.centerBlueprintDir || DEFAULT_CENTER_DIR;
  const pollMs = opts.pollMs || 5000;
  const capMs = opts.capMs || 40 * 60 * 1000;
  const log = opts.log || ((m) => console.log('[evolve-center] ' + m));
  const health = opts.health || null;
  let running = false;
  let last = null;

  const iso = () => nowFn().toISOString();

  // 同机蚕丛上的中心工作流与本仓 center-blueprint/ 版本对齐（不一致 ⇒ 删了重导）
  async function ensureCenterBlueprint() {
    const want = (readJson(path.join(centerDir, 'blueprint.json')) || {}).version;
    const cur = await client.readFile(CENTER_ID, 'blueprint.json');
    if (cur.ok) {
      let have = null;
      try { have = JSON.parse(decodeFile(cur.body)).version; } catch (_) { /* 坏了就重装 */ }
      if (have && have === want) return;
      const d = await client.deleteBlueprint(CENTER_ID);
      if (!d.ok && d.status !== 404) throw errOf(d, 'DELETE /_blueprint/' + CENTER_ID);
    }
    const r = await client.importLocal(path.resolve(centerDir));
    if (!r.ok) throw errOf(r, 'POST /_blueprint/import（local ' + CENTER_ID + '）');
    log('installed ' + CENTER_ID + ' ' + want);
  }

  async function waitRun(cwd, runId) {
    const deadline = Date.now() + capMs;
    let missing = 0;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const s = await client.runState(cwd);
      const st = s.ok ? s.body.state : null;
      if (!st || st.runId !== runId) {
        if (++missing * pollMs > 120000) throw new Error('run 状态读不到（' + (s.status || 'net') + '）');
        continue;
      }
      missing = 0;
      const kind = s.body.runOutcome && s.body.runOutcome.kind;
      if (kind && kind !== 'running') return s.body.runOutcome;
    }
    await client.stopRun(cwd, runId);
    throw new Error('中心 run 超时（' + Math.round(capMs / 60000) + ' 分钟），已停止');
  }

  // 写输入：manifest / samples.jsonl（流式）/ clusters.json / base/<node>/SKILL.md
  async function writeInputs(cwd, bpId, batchId, base) {
    const inDir = path.join(cwd, 'input');
    mkdirOpen(inDir); mkdirOpen(path.join(cwd, 'output')); mkdirOpen(path.join(cwd, 'output', 'synth'));
    const refSig = new Map();
    const nodes = new Set();
    const fd = fs.openSync(path.join(inDir, 'samples.jsonl'), 'w');
    try {
      for (const row of dao.evoIterBatchReps(batchId)) {
        const p = parse(row.payload);
        const ref = 's' + row.id;
        refSig.set(ref, { signature: row.signature, nodeId: row.nodeId });
        if (row.nodeId) nodes.add(row.nodeId);
        fs.writeSync(fd, JSON.stringify({
          ref, signature: row.signature, nodeId: row.nodeId, count: row.n, machines: row.machines,
          signal: p.signal || null, diff: p.diff || '', rationale: p.rationale || '', evidence: p.evidence || [],
        }) + '\n');
      }
    } finally { fs.closeSync(fd); }
    const clusters = dao.evoClustersOfBp(bpId).map((c) => {
      if (c.status === 'open' && c.nodeId) nodes.add(c.nodeId);
      return {
        ref: 'c' + c.id, nodeId: c.nodeId, title: c.title, status: c.status, resynth: !!c.resynth,
        summary: c.synthSummary || null, runs: c.runs, machines: c.machines,
        members: dao.evoClusterReps(c.id, REPS_PER_CLUSTER).map((m) => ({
          signature: m.signature, signal: m.payload.signal || null, diff: m.payload.diff || '', rationale: m.payload.rationale || '',
        })),
      };
    });
    fs.writeFileSync(path.join(inDir, 'clusters.json'), JSON.stringify(clusters, null, 2));
    const baseText = new Map();
    for (const n of nodes) {
      const txt = await readSkill(client, base.id, n);
      if (txt == null) continue;
      baseText.set(n, txt);
      mkdirOpen(path.join(inDir, 'base', n));
      fs.writeFileSync(path.join(inDir, 'base', n, 'SKILL.md'), txt);
    }
    fs.writeFileSync(path.join(inDir, 'manifest.json'), JSON.stringify({
      schema: 'evolve-center-input/1', blueprintId: bpId, baseVersion: base.version,
      nodes: [...baseText.keys()], samples: refSig.size, clusters: clusters.length,
    }, null, 2));
    return { refSig, baseText };
  }

  // 读输出入库：挂簇（同签名全部）→ 重算计数 → 合成只落 open 簇
  function ingestOutputs(cwd, bpId, batchId, base, ctx) {
    const out = path.join(cwd, 'output');
    const assign = readJson(path.join(out, 'assign.json'));
    if (!assign || !Array.isArray(assign.assignments)) throw new Error('output/assign.json 缺失或格式不对');
    const review = readJson(path.join(out, 'review.json'));
    const reviewOf = new Map((Array.isArray(review) ? review : []).filter((r) => r && r.ref).map((r) => [String(r.ref), r]));
    const ts = iso();
    const own = new Map(dao.evoClustersOfBp(bpId).map((c) => [c.id, c]));
    let newClusters = 0; let synthesized = 0;

    dao.evoTx(() => {
      const keyToId = new Map();
      for (const nc of Array.isArray(assign.newClusters) ? assign.newClusters : []) {
        if (!nc || !nc.key || keyToId.has(String(nc.key))) continue;
        const id = dao.evoInsertCluster({ bpId, nodeId: nc.nodeId || null, title: String(nc.title || '').slice(0, 200), now: ts });
        keyToId.set(String(nc.key), id); own.set(id, { id, status: 'open', nodeId: nc.nodeId || null, resynth: 0 });
        newClusters++;
      }
      const refOf = new Map([...keyToId].map(([k, id]) => [id, k]));
      const touched = new Set();
      for (const a of assign.assignments) {
        const s = a && ctx.refSig.get(String(a.sample));
        if (!s) continue;
        let cid = null;
        if (a.newKey != null) cid = keyToId.get(String(a.newKey)) || null;
        else if (typeof a.cluster === 'string' && /^c\d+$/.test(a.cluster)) cid = Number(a.cluster.slice(1));
        if (!cid || !own.has(cid)) continue;   // 只认本蓝图的簇
        dao.evoAssignSignature(s.signature, cid);
        touched.add(cid);
      }
      for (const cid of touched) dao.evoRecountCluster(cid, ts);
      // LLM 漏分配的样本：按失败退回（attempts+1）
      dao.evoReleaseBatch(batchId);

      const targets = new Set([...touched].filter((id) => own.get(id).status === 'open'));
      for (const c of own.values()) if (c.status === 'open' && c.resynth) targets.add(c.id);
      for (const cid of targets) {
        const ref = refOf.get(cid) || ('c' + cid);
        let text = null;
        try { text = fs.readFileSync(path.join(out, 'synth', ref + '.txt'), 'utf8'); } catch (_) { continue; }
        const parsed = parseSynth(text);
        const flags = [];
        const node = own.get(cid).nodeId;
        if (!parsed) flags.push('format');
        else if (!ctx.baseText.has(node) || !applyHunks(ctx.baseText.get(node), parsed.hunks).ok) flags.push('anchor');
        const rv = reviewOf.get(ref) || {};
        for (const f of Array.isArray(rv.flags) ? rv.flags : []) if (FLAG_SET.has(f) && !flags.includes(f)) flags.push(f);
        const pass = !flags.length && rv.pass === true;
        // evoSetSynth 带 status='open' 条件：已裁决簇物理写不进合成补丁
        synthesized += dao.evoSetSynth(cid, {
          synthText: text.slice(0, 64 * 1024), synthSummary: parsed ? parsed.summary.slice(0, 2000) : null,
          baseVersion: base.version, reviewPass: pass, reviewFlags: flags,
          reviewNotes: typeof rv.notes === 'string' ? rv.notes.slice(0, 4000) : null, now: ts,
        });
      }
    })();
    return { newClusters, synthesized };
  }

  async function processBatch(bpId, trigger) {
    const ts = iso();
    const batchId = dao.evoInsertBatch({ bpId, trigger, now: ts });
    const cwd = path.join(workRoot, 'batch-' + batchId);
    const n = dao.evoMarkBatched(bpId, batchId);
    dao.evoUpdateBatch(batchId, { samples: n });
    try {
      mkdirOpen(cwd);
      const cfg = readConfig(dao);
      const base = await resolveBase(client, cfg.market, bpId);
      const ctx = await writeInputs(cwd, bpId, batchId, base);
      const r = await client.startRun(cwd, CENTER_ID);
      if (!r.ok && r.status === 503) throw Object.assign(errOf(r, 'POST /_blueprint/run'), { noBurn: true, tool: r.body.tool || null });
      if (!r.ok || !r.body.runId) throw errOf(r, 'POST /_blueprint/run');
      if (health) health.clearToolMissing();
      dao.evoUpdateBatch(batchId, { runId: r.body.runId });
      const outcome = await waitRun(cwd, r.body.runId);
      if (outcome.kind !== 'done') {
        throw new Error('中心 run 结局 ' + outcome.kind + (outcome.stop ? '（' + outcome.stop.code + '）' : ''));
      }
      const res = ingestOutputs(cwd, bpId, batchId, base, ctx);
      dao.evoUpdateBatch(batchId, { status: 'done', newClusters: res.newClusters, synthesized: res.synthesized, endedAt: iso() });
      return Object.assign({ batchId, ok: true }, res);
    } catch (e) {
      if (e && e.noBurn) {
        dao.evoUnbatch(batchId);
        if (health) health.noteToolMissing(e.tool);
        const msg = '执行器缺工具 ' + (e.tool || '?') + '（退回队列，不计重试）';
        dao.evoUpdateBatch(batchId, { status: 'failed', error: msg, endedAt: iso() });
        log('batch ' + batchId + ' (' + bpId + ') ' + msg);
        return { batchId, ok: false, error: msg, stop: true };
      }
      dao.evoReleaseBatch(batchId);
      dao.evoUpdateBatch(batchId, { status: 'failed', error: String(e && e.message).slice(0, 1000), endedAt: iso() });
      log('batch ' + batchId + ' (' + bpId + ') failed: ' + (e && e.message));
      return { batchId, ok: false, error: e && e.message };
    }
  }

  async function processQueue(o) {
    if (running) return { busy: true };
    running = true;
    const trigger = (o && o.trigger) || 'manual';
    const results = [];
    try {
      const bps = dao.evoQueuedBlueprints();
      if (bps.length) {
        if (health) {
          const h = await health.check({ force: true });
          if (!h.canRun) {
            const why = h.items.filter((x) => x.level === 'red').map((x) => x.msg).join('；');
            const id = dao.evoInsertBatch({ bpId: null, trigger, now: iso() });
            dao.evoUpdateBatch(id, { status: 'failed', error: ('体检未过：' + why).slice(0, 1000), endedAt: iso() });
            log('health check failed, queue not started: ' + why);
            return (last = { ok: false, blocked: true, health: h, results });
          }
        }
        try { await ensureCenterBlueprint(); }
        catch (e) {
          const id = dao.evoInsertBatch({ bpId: null, trigger, now: iso() });
          dao.evoUpdateBatch(id, { status: 'failed', error: '中心工作流安装失败：' + String(e && e.message).slice(0, 900), endedAt: iso() });
          log('ensure center blueprint failed: ' + (e && e.message));
          return (last = { ok: false, error: e && e.message, results });
        }
        for (const bp of bps) {
          const r = await processBatch(bp, trigger);
          results.push(r);
          if (r.stop) break;   // 缺工具：余下蓝图同样会 503，别空转
        }
      }
      return (last = { ok: true, results });
    } finally { running = false; }
  }

  return { processQueue, isRunning: () => running, lastResult: () => last, CENTER_ID };
}

module.exports = { createRunner, CENTER_ID, DEFAULT_CENTER_DIR };

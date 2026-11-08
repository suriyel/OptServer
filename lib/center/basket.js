'use strict';
// center/basket.js —— 采纳篮子落地（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §5.6，Q25/Q26）。
//
// push：该蓝图全部 adopted 簇 → 新鲜副本 X-evo（= 市场最新版）上按节点依次套补丁 → 一次
//   POST /_marketplace/publish {id:'X-evo', asId:X, version: 市场版 +1, message} ⇒ 一条 publish/X-<v> 分支（§8 牙齿 3）。
//   某簇在新版上打不上 ⇒ 退回 open + resynth（下个窗口按新版重新合成），本次跳过它，其余照推。
// exportPatch：X 不在目标市场（或想手工落地）⇒ 套到基线上生成 `git apply` 统一补丁 + 提交说明；不改簇状态。

const { parseSynth, applyHunks, unifiedDiff, bumpVersion } = require('./patch');
const { resolveBase, readSkill, errOf } = require('./upstream');
const { readConfig } = require('../evolve-config');

const MAX_MESSAGE = 8000;

function rate(c) {
  const n = (c.applied || 0) + (c.rejected || 0);
  return n ? Math.round((c.applied / n) * 100) + '%（' + c.applied + '/' + n + '）' : '—';
}

function messageOf(clusters) {
  const parts = clusters.map((c) => {
    const s = parseSynth(c.synthText || '');
    return '## #' + c.id + ' ' + (c.title || '') + '（节点 ' + (c.nodeId || '?') + '）\n'
      + ((s && s.summary) || c.synthSummary || '') + '\n'
      + '机器 ' + c.machines + ' · run ' + c.runs + ' · 本机批准率 ' + rate(c)
      + ' · 审查 ' + (c.reviewPass ? '通过' : '标红' + (c.reviewFlags ? '（' + c.reviewFlags + '）' : ''));
  });
  const msg = '蓝图自进化中心：合入 ' + clusters.length + ' 个补丁簇\n\n' + parts.join('\n\n');
  return msg.length > MAX_MESSAGE ? msg.slice(0, MAX_MESSAGE - 1) + '…' : msg;
}

/** 按节点把各簇依次套到基线上 → { files:[{nodeId, before, after}], applied:[cluster], failed:[cluster] } */
async function applyBasket(client, baseId, clusters) {
  const byNode = new Map();
  for (const c of clusters) {
    if (!byNode.has(c.nodeId)) byNode.set(c.nodeId, []);
    byNode.get(c.nodeId).push(c);
  }
  const files = []; const applied = []; const failed = [];
  for (const [nodeId, list] of byNode) {
    const before = nodeId ? await readSkill(client, baseId, nodeId) : null;
    let text = before;
    for (const c of list) {
      const s = parseSynth(c.synthText || '');
      const r = (text != null && s) ? applyHunks(text, s.hunks) : { ok: false };
      if (r.ok) { text = r.text; applied.push(c); } else failed.push(c);
    }
    if (before != null && text !== before) files.push({ nodeId, before, after: text });
  }
  return { files, applied, failed };
}

function createBasket(dao, client, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const iso = () => nowFn().toISOString();

  async function push(bpId, user) {
    const clusters = dao.evoAdopted(bpId);
    if (!clusters.length) return { ok: false, status: 409, code: 'empty-basket', error: '该蓝图篮子是空的' };
    const cfg = readConfig(dao);
    const base = await resolveBase(client, cfg.market, bpId);
    if (!base.inMarket) {
      return { ok: false, status: 409, code: 'not-in-market',
        error: '蓝图 ' + bpId + ' 不在目标市场「' + base.market.name + '」，请改用「导出补丁」' };
    }
    const ab = await applyBasket(client, base.id, clusters);
    const ts = iso();
    for (const c of ab.failed) dao.evoMarkResynth(c.id, '推送时在市场版 ' + base.version + ' 上打不上，已退回重新合成', ts);
    if (!ab.applied.length) {
      dao.evoAudit({ ts, user, action: 'push-skip', target: bpId, detail: { failed: ab.failed.map((c) => c.id) } });
      return { ok: false, status: 409, code: 'nothing-applies', error: '篮子里的补丁在市场最新版上都打不上，已全部退回重新合成',
        failed: ab.failed.map((c) => c.id) };
    }
    for (const f of ab.files) {
      const w = await client.writeFile(base.id, 'skills/' + f.nodeId + '/SKILL.md', f.after);
      if (!w.ok) throw errOf(w, 'POST /_blueprint/' + base.id + '/file');
    }
    const message = messageOf(ab.applied);
    let version = bumpVersion(base.version);
    const body = { name: base.market.name, id: base.id, asId: bpId, author: user || 'evolve-center', message };
    let r = await client.publish(Object.assign({ version }, body));
    if (!r.ok && r.status === 409 && r.body.code === 'version-not-bumped' && r.body.marketVersion) {
      version = bumpVersion(r.body.marketVersion);   // 目录缓存与推前刷新之间市场又进了一版
      r = await client.publish(Object.assign({ version }, body));
    }
    if (!r.ok) throw errOf(r, 'POST /_marketplace/publish');
    const branch = r.body.branch || ('publish/' + bpId + '-' + version);
    dao.evoTx(() => { for (const c of ab.applied) dao.evoSetPushed(c.id, branch, iso()); })();
    dao.evoAudit({ ts: iso(), user, action: 'push', target: bpId,
      detail: { branch, version, market: base.market.name, pushed: ab.applied.map((c) => c.id), skipped: ab.failed.map((c) => c.id) } });
    return { ok: true, branch, version, pushed: ab.applied.map((c) => c.id), skipped: ab.failed.map((c) => c.id) };
  }

  async function exportPatch(bpId, user) {
    const clusters = dao.evoAdopted(bpId);
    if (!clusters.length) return { ok: false, status: 409, code: 'empty-basket', error: '该蓝图篮子是空的' };
    const cfg = readConfig(dao);
    const base = await resolveBase(client, cfg.market, bpId);
    const ab = await applyBasket(client, base.id, clusters);
    const diff = await unifiedDiff(ab.files.map((f) => ({
      rel: 'blueprints/' + bpId + '/skills/' + f.nodeId + '/SKILL.md', before: f.before, after: f.after,
    })));
    const head = messageOf(ab.applied).split('\n').map((l) => '# ' + l).join('\n') + '\n'
      + '# 基线：' + (base.inMarket ? '市场「' + base.market.name + '」' : '中心机本机') + ' ' + bpId + ' ' + (base.version || '?') + '\n'
      + (ab.failed.length ? '# 未套上（基线已变，需重新合成）：' + ab.failed.map((c) => '#' + c.id).join(' ') + '\n' : '')
      + '# 在目标仓根执行：git apply <本文件>\n';
    dao.evoAudit({ ts: iso(), user, action: 'export', target: bpId, detail: { clusters: ab.applied.map((c) => c.id), failed: ab.failed.map((c) => c.id) } });
    return { ok: true, text: head + diff, applied: ab.applied.length, failed: ab.failed.length };
  }

  return { push, exportPatch };
}

module.exports = { createBasket, messageOf, applyBasket };

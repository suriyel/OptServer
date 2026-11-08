'use strict';
// center/upstream.js —— 「上游版本」解析：目标市场 + 把市场里的 X 拉成同机蚕丛上的 X-evo 副本。
//
// 设计 §5.6 原文是「市场安装/更新 X → 复制为 X-evo」。实施改为 **从市场直接装成副本 X-evo**
// （POST /_blueprint/import {source:{type:'market', name, id:X, installAs:'X-evo'}}）：
// 中心机上内置种子的 X 没有市场安装记录，「从市场装 X」会 409 id-owned-locally 且 force 压不过；
// 装成副本效果相同（副本 = 市场最新版），完全不碰本机 X；走市场通道 ⇒ ssh / 官方双地址 / 凭据与市场安装同一套
// （git import 只收 https 公网地址，用不了）。
// X 不在目标市场目录里 ⇒ 用中心机本机的 X 当基线（只够导出补丁，推不了分支）。

const EVO_SUFFIX = '-evo';

function decodeFile(body) {
  if (!body || typeof body.content !== 'string') return null;
  return body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString('utf8') : body.content;
}

const errOf = (r, what) => {
  const b = r.body || {};
  const e = new Error(what + ' → HTTP ' + r.status + ' ' + (b.code || '') + ' ' + (b.error || b.message || ''));
  e.status = r.status; e.code = b.code || null;
  return e;
};

/** 目标市场：配置的 market（同机蚕丛没登记就先登记）‖ 蚕丛登记的第一个（首启种子 = 官方） */
async function resolveMarket(client, cfgMarket) {
  const s = await client.settings();
  if (!s.ok) throw errOf(s, 'GET /api/settings');
  // GET /api/settings 回 { settings: { marketplaces:[{name,url,ref}] } }（PUT 收的是扁平 { marketplaces }）
  const st = s.body.settings || {};
  const list = Array.isArray(st.marketplaces) ? st.marketplaces : [];
  if (!cfgMarket) {
    if (!list.length) throw Object.assign(new Error('同机蚕丛没有登记任何市场，请在配置页指定目标市场'), { code: 'no-market' });
    return list[0];
  }
  const hit = list.find((m) => m && m.name === cfgMarket.name);
  if (hit) return hit;
  const r = await client.putSettings({ marketplaces: list.concat([cfgMarket]) });
  if (!r.ok) throw errOf(r, 'PUT /api/settings（登记目标市场）');
  return cfgMarket;
}

/** 市场目录里 X 的条目（不在 ⇒ null） */
async function marketEntry(client, market, bpId) {
  const c = await client.catalog(market.name);
  if (!c.ok) throw errOf(c, 'GET /_marketplace/catalog');
  const list = Array.isArray(c.body.blueprints) ? c.body.blueprints : [];
  return list.find((b) => b && b.id === bpId) || null;
}

/** 把市场里的 X 装成 X-evo（先删旧副本）→ 返回副本 id。调用前 marketEntry 已 refresh 过目录缓存。 */
async function freshCopy(client, market, bpId) {
  const evoId = bpId + EVO_SUFFIX;
  const d = await client.deleteBlueprint(evoId);
  if (!d.ok && d.status !== 404) throw errOf(d, 'DELETE /_blueprint/' + evoId);
  const r = await client.importMarketAs(market.name, bpId, evoId);
  if (!r.ok) throw errOf(r, 'POST /_blueprint/import（market ' + bpId + ' → ' + evoId + '）');
  return evoId;
}

/**
 * 基线：{ id（读文件用的蚕丛蓝图 id）, version, inMarket, market, entry }。
 * 市场有 X ⇒ 新鲜副本 X-evo；没有 ⇒ 本机 X；都没有 ⇒ 抛。
 */
async function resolveBase(client, cfgMarket, bpId) {
  const market = await resolveMarket(client, cfgMarket);
  const entry = await marketEntry(client, market, bpId);
  if (entry) {
    const id = await freshCopy(client, market, bpId);
    return { id, version: entry.version || null, inMarket: true, market, entry };
  }
  const bj = await client.readFile(bpId, 'blueprint.json');
  if (!bj.ok) throw Object.assign(errOf(bj, '蓝图 ' + bpId + ' 既不在目标市场「' + market.name + '」也不在中心机本机'), { code: 'no-base' });
  let version = null;
  try { version = JSON.parse(decodeFile(bj.body)).version || null; } catch (_) { /* 无版本号照样可导出 */ }
  return { id: bpId, version, inMarket: false, market, entry: null };
}

async function readSkill(client, baseId, nodeId) {
  const r = await client.readFile(baseId, 'skills/' + nodeId + '/SKILL.md');
  return r.ok ? decodeFile(r.body) : null;
}

module.exports = { resolveMarket, marketEntry, freshCopy, resolveBase, readSkill, decodeFile, errOf, EVO_SUFFIX };

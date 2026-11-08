'use strict';
// center/cancong-client.js —— 回环调同机蚕丛独立版（TechDemos docs/LINUX-STANDALONE-SERVER-DESIGN.md §6）。
// 蚕丛的 /_blueprint/* /_marketplace/* /api/* 只靠绑 127.0.0.1、无 token ⇒ 这里不带任何凭据，也不该带。
// 基址：env OPS_CANCONG_URL，默认 http://127.0.0.1:5599（独立版安装器默认端口）。
// 每个调用一律返回 { ok, status, body }（不抛），调用方按 status / body.code 分支；网络错 ⇒ status 0。

const DEFAULT_URL = 'http://127.0.0.1:5599';

function createCancongClient(opts) {
  const base = String((opts && opts.baseUrl) || process.env.OPS_CANCONG_URL || DEFAULT_URL).replace(/\/+$/, '');
  const timeoutMs = (opts && opts.timeoutMs) || 120000;
  // 中心 run 用的工具（缺省 = 蚕丛自己的缺省：上次用的工具 ▷ codeagent3）；中心机一般要显式钉一个装好的
  const tool = (opts && opts.tool) || process.env.OPS_CANCONG_TOOL || '';

  async function call(method, p, body, qs) {
    const q = qs ? Object.fromEntries(Object.entries(qs).filter(([, v]) => v != null)) : null;
    const url = base + p + (q && Object.keys(q).length ? '?' + new URLSearchParams(q).toString() : '');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method, signal: ctl.signal,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text.slice(0, 500) }; }
      return { ok: res.ok, status: res.status, body: json || {} };
    } catch (e) {
      return { ok: false, status: 0, body: { error: (e && e.name === 'AbortError') ? 'timeout' : String(e && e.message) } };
    } finally { clearTimeout(t); }
  }

  const enc = encodeURIComponent;
  return {
    baseUrl: base,
    settings: () => call('GET', '/api/settings'),
    putSettings: (patch) => call('PUT', '/api/settings', patch),
    catalog: (name) => call('GET', '/_marketplace/catalog', undefined, { name, refresh: '1' }),
    readFile: (id, rel) => call('GET', '/_blueprint/' + enc(id) + '/file', undefined, { path: rel }),
    writeFile: (id, rel, content) => call('POST', '/_blueprint/' + enc(id) + '/file', { path: rel, content }),
    deleteBlueprint: (id) => call('DELETE', '/_blueprint/' + enc(id)),
    // 市场上的 X 装成本机副本 installAs（TechDemos marketplace.installFromMarket 的 installAs；不碰本机 X、不记市场来源）
    importMarketAs: (name, id, installAs) => call('POST', '/_blueprint/import', { source: { type: 'market', name, id, installAs } }),
    importLocal: (absPath) => call('POST', '/_blueprint/import', { source: { type: 'local', absPath }, options: { idStrategy: 'from-meta' } }),
    startRun: (cwd, blueprintId) => call('POST', '/_blueprint/run', Object.assign({ cwd, blueprintId, fresh: true }, tool ? { tool } : {})),
    runState: (cwd, runId8) => call('GET', '/_blueprint/state', undefined, { cwd, runId8 }),
    stopRun: (cwd, runId) => call('POST', '/_blueprint/stop-session', { cwd, runId }),
    publish: (b) => call('POST', '/_marketplace/publish', b),
    // 执行器体检（lib/center/health.js）：在线规格（核 partner op 都在）、环境变量生效值（核 BP_EVOLVE 已关）
    openapi: () => call('GET', '/_api/openapi.json'),
    envList: () => call('GET', '/_env/list'),
  };
}

module.exports = { createCancongClient, DEFAULT_URL };

'use strict';
// center/health.js —— 执行器体检（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §11.2 D2）。
// 中心机配错（连不上 / 不是独立版 / 蚕丛版本不带本仓依赖的契约 / BP_EVOLVE 没关 / 目标市场读不出 / 缺工具）
// 以前全静默：批次失败原因里埋一句 HTTP 503，看板上看不出来。体检把它们变成红黄灯：
//   red  ⇒ canRun=false：批次不开跑（也不烧样本的重试次数）；market red ⇒ canPush=false：推送 / 导出置灰
//   warn ⇒ 照跑，只提示（BP_EVOLVE 没关 = 多产提案、不坏数据；版本落后 = 附升级命令，**不代执行**）
// 体检本身零副作用：不登记市场、不起 run（缺工具只能靠起 run 时的 503 得知，由 runner 回报 noteToolMissing）。

const { PARTNER_OPS } = require('./partner-ops');
const { readConfig } = require('../evolve-config');
const { cmp3 } = require('../update');

const OFF = new Set(['0', 'false', 'off', 'no']);
const ARCH = { x64: 'x64', arm64: 'arm64' };

function createHealth(client, opts) {
  opts = opts || {};
  const dao = opts.dao;
  const nowFn = opts.nowFn || (() => new Date());
  const ttlMs = opts.ttlMs == null ? 30000 : opts.ttlMs;
  const arch = ARCH[opts.arch || process.arch] || null;
  const feedLatest = opts.feedLatest || (() => null);       // → 已发布 manifest | null（lib/update.js readPublishedManifest）
  const feedBase = opts.feedBase || ('http://127.0.0.1:' + (Number(process.env.PORT) || 5900));
  let cache = null; let inflight = null; let toolMissing = null;

  async function compute() {
    const items = [];
    const add = (id, level, msg, extra) => items.push(Object.assign({ id, level, msg }, extra || {}));

    const s = await client.settings();
    if (!s.ok) {
      add('reachable', 'red', '连不上同机蚕丛（' + client.baseUrl + '，HTTP ' + s.status + '）',
        { hint: '确认蚕丛独立版服务在跑（systemctl status cancong-server）且 OPS_CANCONG_URL 指向它的回环端口' });
      return finish(items);
    }
    add('reachable', 'ok', '同机蚕丛可达（' + client.baseUrl + '）');
    const st = (s.body && s.body.settings) || {};

    if (st.standalone === true) add('standalone', 'ok', '独立版节点（版本 ' + (st.version || '?') + '）');
    else add('standalone', 'red', '不是独立版节点', { hint: '客户端托管的节点随 SSH 连接重启，不能当执行器；按 LINUX-STANDALONE-SERVER-DESIGN 安装独立版' });

    const o = await client.openapi();
    if (!o.ok || !o.body || !o.body.paths) {
      add('contract', 'red', '取不到在线规格 /_api/openapi.json（HTTP ' + o.status + '）', { hint: '蚕丛版本过旧：先升级中心机蚕丛' });
    } else {
      const missing = PARTNER_OPS.filter(([m, p]) => {
        const op = o.body.paths[p] && o.body.paths[p][m];
        return !op || op['x-stability'] !== 'partner';
      }).map(([m, p]) => m.toUpperCase() + ' ' + p);
      const ver = (o.body.info && o.body.info.version) || st.version || '?';
      if (missing.length) add('contract', 'red', '蚕丛版本 ' + ver + ' 与本 OptServer 不兼容：缺 ' + missing.join('、'), { hint: '先升级中心机蚕丛，再升 OptServer' });
      else add('contract', 'ok', '契约兼容（' + PARTNER_OPS.length + ' 个 partner 接口齐全）');
    }

    const e = await client.envList();
    const row = e.ok && Array.isArray(e.body.rows) ? e.body.rows.find((r) => r && r.key === 'env.bp_evolve') : null;
    if (row && row.currentValue != null && OFF.has(String(row.currentValue).trim().toLowerCase())) add('evolveOff', 'ok', '中心机自进化已关（BP_EVOLVE=0）');
    else add('evolveOff', 'warn', '中心机自进化没关（BP_EVOLVE=' + (row && row.currentValue != null ? row.currentValue : '缺省 1') + '）：中心 run 自己会产提案，形成回路',
      { hint: '在中心机独立版 EnvironmentFile 设 BP_EVOLVE=0 后重启（安装时 --env BP_EVOLVE=0）' });

    const cfg = dao ? readConfig(dao) : {};
    const list = Array.isArray(st.marketplaces) ? st.marketplaces : [];
    const target = cfg.market ? list.find((m) => m && m.name === cfg.market.name) : list[0];
    if (cfg.market && !target) add('market', 'warn', '目标市场「' + cfg.market.name + '」还没登记到同机蚕丛，推送时自动登记（目录可读性届时才知道）');
    else if (!target) add('market', 'red', '同机蚕丛没有登记任何市场', { hint: '在配置页指定目标市场' });
    else {
      const c = await client.catalog(target.name);
      if (c.ok) add('market', 'ok', '目标市场「' + target.name + '」目录可读（ref ' + (target.ref || 'main') + '）');
      else add('market', 'red', '目标市场「' + target.name + '」目录读不出（HTTP ' + c.status + ' ' + ((c.body && (c.body.code || c.body.error)) || '') + '）',
        { hint: '检查市场地址与 ref（官方市场是 master）及中心机的 git 凭据' });
    }

    const man = feedLatest();
    const pkg = man && arch && man.packages ? man.packages['linux-' + arch] : null;
    if (!pkg) add('version', 'na', '内网 feed 上没有 linux-' + (arch || process.arch) + ' 包，无从比较版本');
    else if (st.version && cmp3(st.version, man.version) === -1) {
      const root = st.installRoot || '<安装根>';
      const f = pkg.file;
      add('version', 'warn', '蚕丛 ' + st.version + ' 落后于内网 feed 的 ' + man.version, {
        hint: '到中心机上手动执行（升级须 root，OptServer 不代执行；有在跑的中心 run 会被打断）',
        cmd: 'curl -fLo /tmp/' + f + ' ' + feedBase + '/v1/update/download/' + f + ' && echo \'' + pkg.sha256 + '  /tmp/' + f
          + '\' | sha256sum -c - && sudo ' + root + '/bootstrap.sh --upgrade /tmp/' + f,
      });
    } else add('version', 'ok', '版本不落后于内网 feed（' + (st.version || '?') + ' / ' + man.version + '）');

    return finish(items);
  }

  function finish(items) {
    if (toolMissing) items.push({ id: 'tool', level: 'red', msg: '执行器缺工具 ' + toolMissing.tool + '（' + toolMissing.at + ' 起 run 返回 503）',
      hint: '中心机装好该 CLI 并 --reconfigure，或用 OPS_CANCONG_TOOL 换成已装的工具；下次批次自动重试' });
    const lv = (id) => (items.find((x) => x.id === id) || {}).level;
    const canRun = ['reachable', 'standalone', 'contract'].every((id) => lv(id) === 'ok');
    const canPush = canRun && lv('market') !== 'red';
    const overall = items.some((x) => x.level === 'red') ? 'red' : items.some((x) => x.level === 'warn') ? 'warn' : 'ok';
    return { at: nowFn().toISOString(), atMs: nowFn().getTime(), overall, canRun, canPush, items };
  }

  function check(o) {
    const force = !!(o && o.force);
    if (!force && cache && nowFn().getTime() - cache.atMs < ttlMs) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = compute().then((r) => (cache = r)).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    check,
    last: () => cache,
    noteToolMissing(tool) { toolMissing = { tool: tool || '?', at: nowFn().toISOString() }; cache = null; },
    clearToolMissing() { if (toolMissing) { toolMissing = null; cache = null; } },
  };
}

module.exports = { createHealth };

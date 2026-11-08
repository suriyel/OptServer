'use strict';
// update.js —— 应用自动更新发布面（客户端设计：TechDemos docs/APP-AUTO-UPDATE-DESIGN.md §5/§7）。
//
// 免鉴权（lib/auth.js 门禁白名单放行，与 POST /v1/events 同档——客户端没有账号，内网即信任）：
//   GET /v1/update/latest[?current=] → 200 manifest | 204（尚无已发布版本，或 current 已 ≥ 已发布版本）
//   GET /v1/update/download/:file    → res.sendFile（原生支持 Range → 断点续传白拿）
// 鉴权内（运维动作；上传/发布/下架/删草稿另加 requireAdmin——任何人都能推包等于任何人都能给全公司装东西）：
//   POST   /v1/update/upload?variant=&version=   raw stream 上传（不经 json body parser，边写边算 sha256）
//   GET    /v1/update/drafts                     草稿区就位情况 + 当前已发布
//   POST   /v1/update/publish                    { version, notes, minSupported }，服务端自检通过才移入发布区
//   POST   /v1/update/unpublish                  下架/回滚到上一个已发布版本（或清空 → /latest 返 204）
//   DELETE /v1/update/draft/:version/:variant    删草稿
//
// 产品维度（?product=，缺省 cancong）：cancong = 蚕丛客户端（下面的变体与存储）；evolve = 自进化服务 cancong-evolve 的
// Linux 预构建包（独立版本号与 index.json，落 releases/evolve/，规范名 cancong-evolve-<ver>-linux-<arch>.tar.gz）。
// 存储（文件系统而非 SQLite——与遥测库解耦，出事时运维可直接 cat/手改 index.json 救急）：
//   releases/
//   ├── index.json                { published: <manifest>|null, history: [<manifest>...] 最新在前 }
//   ├── staging/<ver>/<variant><ext> + <variant>.json（{originalName,size,sha256,uploadedAt} 边车）
//   └── published/<ver>/cancong-portable-<ver>[-with-linux].exe   ← 保留最近 3 个版本供回滚，更旧自动清理
//                      cancong-server-<ver>-linux-<arch>.tar.gz   ← Linux 独立版包（可选变体）
//
// 变体：slim / with-linux 两个 exe **必需**（只发一个会让另一变体用户静默停更）；linux-x64 / linux-arm64 是
// 蚕丛 Linux 独立版包，**可选**（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §11.3 D3：中心机执行器体检
// 据此提示「版本落后」并给出从本 feed 取包的升级命令；升级本身须 root，不代执行）。Windows 客户端只读自己那个 key，
// manifest 多出 Linux 条目对它无影响；Linux 包不派生解压道（它本来就是 tar.gz）。
//
// 命名归一：上传落盘即抛弃原始名（含空格的「cancong Portable 0.0.4.exe」），发布时统一成无空格
// slug（规避 URL 编码问题）；客户端只认 manifest 里的 packages[variant].file，绝不自己拼文件名。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { requireAdmin } = require('./auth');
const { deriveArchive, canonicalArchiveName } = require('./archive-derive');

const VARIANT_DEFS = [
  { id: 'slim', ext: '.exe', required: true, archive: true },
  { id: 'with-linux', ext: '.exe', required: true, archive: true },
  { id: 'linux-x64', ext: '.tar.gz', required: false, archive: false, arch: 'x64' },
  { id: 'linux-arm64', ext: '.tar.gz', required: false, archive: false, arch: 'arm64' },
];
// 自进化服务 cancong-evolve 的预构建包（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §5.6）：
// 走同一套发布面，但是**独立的产品维度**（自己的版本号 / index.json / 发布区），不进蚕丛的 manifest——
// 否则 EvolveServer 发版就被绑死在蚕丛版本号上。x64 必需、arm64 可选；本身就是 tar.gz，不派生解压道。
const EVOLVE_VARIANT_DEFS = [
  { id: 'linux-x64', ext: '.tar.gz', required: true, archive: false, arch: 'x64' },
  { id: 'linux-arm64', ext: '.tar.gz', required: false, archive: false, arch: 'arm64' },
];

function makeProduct(defs, name) {
  const DEF = Object.fromEntries(defs.map((v) => [v.id, v]));
  return {
    defs, DEF, name,
    VARIANTS: defs.map((v) => v.id),
    ARCHIVE_VARIANTS: defs.filter((v) => v.archive).map((v) => v.id),
    stageName: (va) => va + DEF[va].ext,
  };
}
const ARCH_HINT = { x64: /(?:x64|x86_64|amd64)/i, arm64: /(?:arm64|aarch64)/i };
const VER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const FILE_RE = /^[A-Za-z0-9._-]+$/;   // 下载路由守卫（防路径穿越）
const KEEP_PUBLISHED = 3;              // 发布区保留最近 N 个版本的文件
const HISTORY_CAP = 50;                // history 元数据上限（只裁元数据，不影响文件保留策略）

function parse3(v) {
  const m = VER_RE.exec(String(v == null ? '' : v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp3(a, b) {
  const pa = parse3(a); const pb = parse3(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; }
  return 0;
}

// 从上传时的原始文件名里抽三段版本号（构建产物天然叫 cancong-portable-<版本>[-with-linux].exe）。
// 抽不到 → null（调用方按 fail-open 处理，不拦）。用于发布自检兜住「标 0.0.4 实为 0.0.3」的发错包。
// 前后守卫都要排除「.数字」：否则 cancong-portable-0.0.3.exe 会被 .exe 的点带偏，
// 而 1.2.3.4 这种四段号则应整体判为抽不到（宁可不拦，也不能拦错）。
function versionFromName(name) {
  const m = /(?:^|[^\d.])(\d+\.\d+\.\d+)(?!\.?\d)/.exec(String(name == null ? '' : name));
  return m ? m[1] : null;
}

// 更新面日志：与本仓其余模块同档（不写文件，只打 stdout 由 journald 收；tag 表见 docs/DEPLOYMENT.md）。
// 有它才能回答「谁在什么版本上、拿走了哪个包、发布的是不是想发的那个」——此前整个更新子系统零日志，
// 2026-08-03 那次「发错包」在服务端一点痕迹都没留下。
function log(msg) { console.log('[update] ' + msg); }

// 无 trust proxy 设置，故优先取 XFF 首段（反代后仍能拿到真实客户端），否则回落 socket 地址。
function ip(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || (req.socket && req.socket.remoteAddress) || '-';
}

function canonicalName(version, variant) {
  const d = VARIANT_DEFS.find((v) => v.id === variant);
  if (d && d.arch) return `cancong-server-${version}-linux-${d.arch}.tar.gz`;
  return variant === 'with-linux'
    ? `cancong-portable-${version}-with-linux.exe`
    : `cancong-portable-${version}.exe`;
}

// 当前已发布的 manifest（index.json 的 published；没有 / 读不出 ⇒ null）。给执行器体检比版本用（lib/center/health.js），
// 与路由里的 readIndex 同一份文件；这里只读、不打日志（体检每 30s 一次，读坏了由 /latest 那条路负责留痕）。
function evolveCanonicalName(version, variant) {
  const d = EVOLVE_VARIANT_DEFS.find((v) => v.id === variant);
  return `cancong-evolve-${version}-linux-${d ? d.arch : variant}.tar.gz`;
}

// 产品 → { 变体表, 规范名, 发布区子目录 }。cancong 发布区就是 OPS_RELEASES_DIR 本身（存量路径不动）；
// 其它产品落 <OPS_RELEASES_DIR>/<产品>/（cancong 的 prunePublished 只扫 published/，互不干扰）。
const PRODUCTS = {
  cancong: Object.assign(makeProduct(VARIANT_DEFS, canonicalName), { subdir: '' }),
  evolve: Object.assign(makeProduct(EVOLVE_VARIANT_DEFS, evolveCanonicalName), { subdir: 'evolve' }),
};

function readPublishedManifest(releasesDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(releasesDir || path.join(__dirname, '..', 'releases'), 'index.json'), 'utf8'));
    return j.published || null;
  } catch (_) { return null; }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function createProductRouter(opts, P) {
  const { VARIANTS, DEF, ARCHIVE_VARIANTS, stageName } = P;
  const canonicalName = P.name;
  const ROOT = path.join(opts.releasesDir || path.join(__dirname, '..', 'releases'), P.subdir);
  const nowFn = opts.nowFn || (() => new Date());
  const stagingDir = (ver) => path.join(ROOT, 'staging', ver);
  const publishedDir = (ver) => path.join(ROOT, 'published', ver);
  const indexFile = () => path.join(ROOT, 'index.json');

  function readIndex() {
    try {
      const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
      return { published: j.published || null, history: Array.isArray(j.history) ? j.history : [] };
    } catch (e) {
      // ENOENT 是正常态（还没发过版）；其余（JSON 坏、权限、IO）等于给全公司发 204 集体停更，
      // 此前整条静默——必须留痕，否则运维只能看到「所有人都不升级了」。
      if (!e || e.code !== 'ENOENT') console.error('[update] index.json 读取失败（本次按「无已发布版本」处理）:', e && e.message);
      return { published: null, history: [] };
    }
  }

  // tmp + rename 原子写：/latest 的读者永远看到完整 JSON
  function writeIndex(idx) {
    fs.mkdirSync(ROOT, { recursive: true });
    const tmp = indexFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
    fs.renameSync(tmp, indexFile());
  }

  function readSidecar(ver, variant) {
    try { return JSON.parse(fs.readFileSync(path.join(stagingDir(ver), variant + '.json'), 'utf8')); }
    catch (_) { return null; }
  }

  // 发布区清理：保留 history 里最新 KEEP_PUBLISHED 个版本的文件目录，其余删除
  function prunePublished(history) {
    const keep = new Set(history.slice(0, KEEP_PUBLISHED).map((m) => m.version));
    let names = [];
    try { names = fs.readdirSync(path.join(ROOT, 'published')); } catch (_) { return; }
    for (const n of names) {
      if (!keep.has(n)) {
        try { fs.rmSync(publishedDir(n), { recursive: true, force: true }); } catch (_) { /* best-effort */ }
      }
    }
  }

  const router = express.Router();

  // publish/unpublish 都改写 index.json：publish 是「读 index → await sha 复算 → 写 index」的
  // check-then-act，并发交叠时后写者拿陈旧快照覆盖（history 丢版本、低版本可能盖掉高版本）。
  // 单运维场景也真实可触（双击/两个页签）——把改 index 的动作整体串行化收口。
  let indexChain = Promise.resolve();
  function serialize(handler) {
    return (req, res) => {
      indexChain = indexChain.then(() => handler(req, res)).catch((e) => {
        if (!res.headersSent) res.status(500).json({ ok: false, error: '内部错误：' + ((e && e.message) || e) });
      });
      return indexChain;
    };
  }

  // ---- 免鉴权面 ----

  // ?current=<本机版本>（可选）：客户端已是最新或更高 → 204，服务端替它闭嘴。有了这道闸，
  // 万一又发出「版本号标错」的包，不必等客户端发版就能止住误提示。参数非法/缺省 → 照常返
  // manifest（fail-open：绝不因为一个查询参数让全公司停更）。
  router.get('/update/latest', (req, res) => {
    const cur = String(req.query.current || '');
    const { published } = readIndex();
    if (!published) { log(`latest current=${cur || '-'} ip=${ip(req)} → 204（尚无已发布版本）`); return res.status(204).end(); }
    // ⚠ 这里绝不能把 cmp3 的 null 兜成 0：index.json 被手改坏时那等于给所有客户端发 204（集体停更）。
    const c = cmp3(cur, published.version);
    if (c !== null && c >= 0) { log(`latest current=${cur} ip=${ip(req)} → 204（已是最新）`); return res.status(204).end(); }
    // ★ 客户端自报版本与已发布版本并排：装完 current 长期不前进 = 发布时版本号标错
    log(`latest current=${cur || '-'} ip=${ip(req)} → 200 ${published.version}`);
    res.json(published);
  });

  router.get('/update/download/:file', (req, res) => {
    const file = String(req.params.file || '');
    const rng = req.headers.range ? ` range=${req.headers.range}` : '';
    const { published } = readIndex();
    if (!FILE_RE.test(file) || !published) {
      log(`download ${file} ip=${ip(req)} → 404（${!published ? '尚无已发布版本' : '文件名非法'}）`);
      return res.status(404).json({ ok: false, error: 'not found' });
    }
    // 命中面 = exe（packages[*].file）+ 派生压缩包（packages[*].archive.file）。
    // ★ 漏放 archive 是设计稿 §3.5 点名「最容易漏、表征最迷惑」的一处：manifest 有 archive、
    //   客户端也去下了，结果 404 → 静默回落执行 exe → 现象与「新方案没生效」一模一样。
    const hit = Object.values(published.packages || {}).some((p) => p
      && (p.file === file || (p.archive && p.archive.file === file)));
    const abs = path.join(publishedDir(published.version), file);
    if (!hit || !fs.existsSync(abs)) {
      log(`download ${file} ip=${ip(req)} → 404（${!hit ? '不在当前已发布清单（已下架？）' : '清单里有但文件不在盘上'}）`);
      return res.status(404).json({ ok: false, error: 'not found' });
    }
    log(`download ${file} ip=${ip(req)}${rng} → sendFile`);
    res.sendFile(abs); // express sendFile 原生支持 Range（客户端 .part 断点续传）
  });

  // ---- 鉴权内（运维动作，requireAdmin）----

  // raw stream 上传：不经 json body parser（express.json 只拦 application/json，octet-stream
  // 直接流到这里）。边写边算 sha256，零额外遍历；同 (version,variant) 重传直接覆盖（幂等）。
  router.post('/update/upload', requireAdmin, (req, res) => {
    const variant = String(req.query.variant || '');
    const version = String(req.query.version || '');
    if (!VARIANTS.includes(variant) || !parse3(version)) {
      return res.status(400).json({ ok: false, error: 'bad variant or version' });
    }
    const dir = stagingDir(version);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, stageName(variant));
    const tmpPath = finalPath + '.uploading';
    const hash = crypto.createHash('sha256');
    let size = 0;
    const out = fs.createWriteStream(tmpPath);
    let failed = false;
    const fail = (status, msg) => {
      if (failed) return;
      failed = true;
      try { out.destroy(); } catch (_) {}
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      if (!res.headersSent) res.status(status).json({ ok: false, error: msg });
    };
    req.on('data', (c) => { hash.update(c); size += c.length; });
    req.on('aborted', () => fail(400, 'upload aborted'));
    req.on('error', () => fail(400, 'upload error'));
    out.on('error', () => fail(500, 'write failed'));
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) return fail(400, 'empty body');
      const sha256hex = hash.digest('hex');
      try {
        fs.renameSync(tmpPath, finalPath); // 覆盖旧草稿（幂等重传）
        fs.writeFileSync(path.join(dir, variant + '.json'), JSON.stringify({
          originalName: req.query.filename ? String(req.query.filename) : null,
          size, sha256: sha256hex, uploadedAt: nowFn().toISOString(),
        }, null, 2));
      } catch (e) { return fail(500, 'stage failed'); }
      res.json({ ok: true, data: { version, variant, size, sha256: sha256hex } });
    });
  });

  router.get('/update/drafts', (req, res) => {
    const idx = readIndex();
    const drafts = [];
    let vers = [];
    try { vers = fs.readdirSync(path.join(ROOT, 'staging')); } catch (_) { /* 空 */ }
    for (const ver of vers.filter((v) => parse3(v)).sort((a, b) => -(cmp3(a, b) || 0))) {
      const variants = {};
      for (const va of VARIANTS) {
        const sc = readSidecar(ver, va);
        if (sc && fs.existsSync(path.join(stagingDir(ver), stageName(va)))) variants[va] = sc;
      }
      if (Object.keys(variants).length) drafts.push({ version: ver, variants });
    }
    res.json({ ok: true, data: {
      published: idx.published
        ? {
          version: idx.published.version, pubDate: idx.published.pubDate, minSupported: idx.published.minSupported || '',
          // 留痕（§3.3）：哪个变体带了解压道压缩包。false = 该变体发布时派生失败，全员走老的 exe 执行路
          archives: Object.fromEntries(ARCHIVE_VARIANTS.map((va) => {
            const p = idx.published.packages && idx.published.packages[va];
            return [va, !!(p && p.archive)];
          })),
        }
        : null,
      history: idx.history.slice(0, KEEP_PUBLISHED).map((m) => ({ version: m.version, pubDate: m.pubDate })),
      drafts,
    } });
  });

  // 发布前服务端自检（任一不过拒绝并说明；「发布」按钮的真正把关在这里，前端只做提示）：
  //   1. 两个 exe 变体都在草稿区（Linux 包可选，在就一起发）；2. 版本号合法三段数字且高于当前已发布；
  //   3. 落盘文件大小与边车一致、sha256 复算一致；4. minSupported 为空或合法且 <= version；
  //   5. 上传文件名里内嵌的版本号（若有）与声明版本一致——防「标 0.0.4 实为 0.0.3」的发错包；
  //   6. Linux 包：文件头是 gzip、原始文件名若带架构须与变体一致（防 x64 包传进 arm64 槽）。
  router.post('/update/publish', requireAdmin, serialize(async (req, res) => {
    const body = req.body || {};
    const version = String(body.version || '');
    const notes = typeof body.notes === 'string' ? body.notes : '';
    const minSupported = String(body.minSupported || '');
    if (!parse3(version)) return res.status(400).json({ ok: false, error: '版本号须为三段数字（如 0.0.4）' });
    const idx = readIndex();
    if (idx.published && (cmp3(version, idx.published.version) || 0) <= 0) {
      return res.status(400).json({ ok: false, error: `版本须高于当前已发布 ${idx.published.version}` });
    }
    if (minSupported) {
      if (!parse3(minSupported)) return res.status(400).json({ ok: false, error: '版本地板须为空或三段数字' });
      if ((cmp3(minSupported, version) || 0) > 0) return res.status(400).json({ ok: false, error: '版本地板不能高于发布版本' });
    }
    const packages = {};
    const origNames = {};   // 发布审计用：originalName 里带着包的**真实**版本号
    for (const va of VARIANTS) {
      const exe = path.join(stagingDir(version), stageName(va));
      const sc = readSidecar(version, va);
      if (!sc || !fs.existsSync(exe)) {
        if (!DEF[va].required) continue;   // Linux 包可选
        return res.status(400).json({ ok: false, error: `草稿区缺 ${va} 变体（slim 与 with-linux 两个 exe 都齐才可发布——只发一个会让另一变体用户静默停更）` });
      }
      let st;
      try { st = fs.statSync(exe); } catch (_) { return res.status(400).json({ ok: false, error: `读 ${va} 失败` }); }
      if (st.size !== sc.size) return res.status(400).json({ ok: false, error: `${va} 文件大小与上传记录不一致（${st.size} ≠ ${sc.size}）` });
      let sha;
      try { sha = await sha256File(exe); } catch (_) { return res.status(500).json({ ok: false, error: `${va} sha256 复算失败` }); }
      if (sha !== sc.sha256) return res.status(400).json({ ok: false, error: `${va} sha256 复算不一致（落盘后被改动？请重新上传）` });
      // 声明版本 vs 包名版本：版本号是运维手输的自由文本，与包内容无关；发错包（标 0.0.4 实为 0.0.3）
      // 会让所有客户端被告知"有新版本"、升完还是老版本 → 无限提示。抽不到版本号则不拦（fail-open）。
      const nameVer = versionFromName(sc.originalName);
      if (nameVer && (cmp3(nameVer, version) || 0) !== 0) {
        return res.status(400).json({ ok: false, error: `${va} 上传的文件名是 ${sc.originalName}（版本 ${nameVer}），与声明版本 ${version} 不符——发错包了？确认无误请重命名后重传` });
      }
      if (DEF[va].arch) {
        const other = DEF[va].arch === 'x64' ? 'arm64' : 'x64';
        if (sc.originalName && ARCH_HINT[other].test(sc.originalName) && !ARCH_HINT[DEF[va].arch].test(sc.originalName)) {
          return res.status(400).json({ ok: false, error: `${va} 上传的文件名是 ${sc.originalName}（架构 ${other}），与变体不符——传错槽了？` });
        }
        let head = Buffer.alloc(0);
        try { const fd = fs.openSync(exe, 'r'); head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd); } catch (_) { /* 下面判不是 gzip */ }
        if (head[0] !== 0x1f || head[1] !== 0x8b) return res.status(400).json({ ok: false, error: `${va} 不是 gzip 包（Linux 独立版应为 .tar.gz）` });
      }
      origNames[va] = sc.originalName || null;
      packages[va] = { file: canonicalName(version, va), size: st.size, sha256: sha };
    }
    // 自检全过 → staging rename 进 published/<ver>/（同卷 rename，快）
    try {
      fs.mkdirSync(publishedDir(version), { recursive: true });
      for (const va of Object.keys(packages)) {
        fs.renameSync(path.join(stagingDir(version), stageName(va)),
          path.join(publishedDir(version), packages[va].file));
      }
      fs.rmSync(stagingDir(version), { recursive: true, force: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: '移入发布区失败：' + e.message });
    }
    // 派生 tar.gz（TechDemos 设计稿 §3：给 ≥0.0.6 客户端一条「零执行下载 exe」的解压道）。
    // ★ 派生失败不阻断发布（否则一个 7z 依赖没配好就能卡住全公司发版）——但必须留痕：
    //   日志 + 发布响应 + /drafts 都能看到，静默降级会让人以为新方案生效了其实全员还在走老路。
    const archiveDerive = {};
    for (const va of ARCHIVE_VARIANTS) {
      const exe = path.join(publishedDir(version), packages[va].file);
      const gzName = canonicalArchiveName(version, va);
      const gzPath = path.join(publishedDir(version), gzName);
      try {
        const t0 = Date.now();
        const d = await deriveArchive(exe, gzPath);
        packages[va].archive = { file: gzName, size: d.size, sha256: d.sha256, unpackedSize: d.unpackedSize };
        archiveDerive[va] = { ok: true };
        // ★ 前缀刻意不是 "publish "：那是发布审计行的独占前缀（update.test.js 有唯一性守卫）
        log(`archive 派生 ${version} ${va} → ${gzName}（${(d.size / 1048576).toFixed(0)}MB，${Date.now() - t0}ms）`);
      } catch (e) {
        archiveDerive[va] = { ok: false, error: (e && e.message) || String(e) };
        log(`archive 派生失败 ${version} ${va}：${(e && e.message) || e} —— 本变体仅含 exe（老升级路），请检查 7z 依赖`);
      }
    }
    const manifest = {
      schemaVersion: 1,
      version,
      pubDate: nowFn().toISOString(),
      notes,
      minSupported,
      packages,
    };
    idx.published = manifest;
    idx.history = [manifest, ...idx.history.filter((m) => m.version !== version)].slice(0, HISTORY_CAP);
    writeIndex(idx);
    prunePublished(idx.history);
    // ★ 发错包审计行：声明版本与两个变体的上传原名（原名里嵌着包的真实版本）并排落日志。
    // 上面的自检只在原名抽得出版本号时才拦得住；原名缺失/被改名时这行就是事后唯一的对账凭据。
    log(`publish ${version} minSupported=${minSupported || '-'} `
      + Object.keys(packages).map((va) => `${va}=${origNames[va] || '(无原名)'}#${packages[va].sha256.slice(0, 8)}`
        + `${!DEF[va].archive ? '' : packages[va].archive ? '+tgz' : '(无archive)'}`).join(' ')
      + ` by=${(req.account && req.account.username) || '-'} ip=${ip(req)}`);
    res.json({ ok: true, data: { published: manifest, archiveDerive } });
  }));

  // 下架/回滚：删当前版本文件，回退到上一个文件仍在的已发布版本；没有则清空（/latest → 204）
  router.post('/update/unpublish', requireAdmin, serialize(async (req, res) => {
    const idx = readIndex();
    if (!idx.published) return res.status(400).json({ ok: false, error: '当前没有已发布版本' });
    const dropped = idx.published.version;
    try { fs.rmSync(publishedDir(dropped), { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    idx.history = idx.history.filter((m) => m.version !== dropped);
    idx.published = idx.history.find((m) => fs.existsSync(publishedDir(m.version))) || null;
    writeIndex(idx);
    log(`unpublish ${dropped} → 现为 ${idx.published ? idx.published.version : '(无)'}`
      + ` by=${(req.account && req.account.username) || '-'} ip=${ip(req)}`);
    res.json({ ok: true, data: {
      dropped,
      published: idx.published ? { version: idx.published.version } : null,
    } });
  }));

  // ---- 启动补派生（backfill）----
  // 已发布版本可能是旧代码（无派生逻辑）发的 exe-only manifest——内网 2026-08-07 的 0.0.5→0.0.6
  // 失败正是这样：客户端只拿得到 exe，被 Windows 策略防护（EDR）拒执行（EACCES）。发布时派生只救
  // 「以后发的版」；这里在服务启动时对当前 published 缺 archive 的变体就地补派生并回写 index——
  // 部署新代码 + 重启即自愈，免去「下架→重传→重发布」舞蹈。
  // 只补 published（/latest 唯一出口），不补 history 旧版本（回滚下架后 published 换人，下次启动同样补）。
  async function backfillArchives() {
    const idx = readIndex();
    const pub = idx.published;
    if (!pub || !pub.packages) return;
    let changed = false;
    for (const va of ARCHIVE_VARIANTS) {   // Linux 包本身就是 tar.gz，不派生（否则每次启动拿 7z 去解它）
      const p = pub.packages[va];
      if (!p || p.archive) continue; // 变体缺席或已有 archive → 不动（幂等：重启不重复派生）
      const exe = path.join(publishedDir(pub.version), p.file);
      if (!fs.existsSync(exe)) { log(`archive 补派生跳过 ${pub.version} ${va}：exe 不在盘（${p.file}）`); continue; }
      const gzName = canonicalArchiveName(pub.version, va);
      const gzPath = path.join(publishedDir(pub.version), gzName);
      try {
        const t0 = Date.now();
        const d = await deriveArchive(exe, gzPath);
        p.archive = { file: gzName, size: d.size, sha256: d.sha256, unpackedSize: d.unpackedSize };
        changed = true;
        log(`archive 补派生 ${pub.version} ${va} → ${gzName}（${(d.size / 1048576).toFixed(0)}MB，${Date.now() - t0}ms）`);
      } catch (e) {
        log(`archive 补派生失败 ${pub.version} ${va}：${(e && e.message) || e} —— 本变体仅含 exe（老升级路），请检查 7z 依赖`);
      }
    }
    if (changed) {
      // readIndex 每次都是新解析对象，history 里的同版本条目与 published 不是同一引用——按版本号指回去
      idx.history = idx.history.map((m) => (m.version === pub.version ? pub : m));
      writeIndex(idx);
    }
  }
  // fire-and-forget 挂 indexChain（与 publish/unpublish 串行互斥）；失败绝不影响服务起监听。
  // _backfillDone 只给测试 await（生产没人等它）。
  router._backfillDone = (indexChain = indexChain.then(backfillArchives).catch((e) => {
    console.error('[update] archive 补派生异常（忽略，服务照常）:', e && e.message);
  }));

  router.delete('/update/draft/:version/:variant', requireAdmin, (req, res) => {
    const ver = String(req.params.version || '');
    const va = String(req.params.variant || '');
    if (!parse3(ver) || !VARIANTS.includes(va)) return res.status(400).json({ ok: false, error: 'bad params' });
    const exe = path.join(stagingDir(ver), stageName(va));
    if (!fs.existsSync(exe)) return res.status(404).json({ ok: false, error: 'not found' });
    try {
      fs.unlinkSync(exe);
      try { fs.unlinkSync(path.join(stagingDir(ver), va + '.json')); } catch (_) {}
      // 目录空了顺手收掉
      if (!fs.readdirSync(stagingDir(ver)).length) fs.rmSync(stagingDir(ver), { recursive: true, force: true });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    res.json({ ok: true });
  });

  return router;
}

// 发布面入口：按 ?product= 分派到各产品自己的路由（缺省 cancong ⇒ 现有客户端 / 看板零感知）。
// 路径不变（/update/latest、/update/download/:file、/update/upload …），产品只走查询参数。
function createUpdateRouter(opts) {
  opts = opts || {};
  const routers = Object.fromEntries(Object.entries(PRODUCTS).map(([k, P]) => [k, createProductRouter(opts, P)]));
  const outer = express.Router();
  outer.use((req, res, next) => {
    if (!req.path.startsWith('/update/')) return next();
    const product = String(req.query.product || 'cancong');
    const r = routers[product];
    if (!r) return res.status(400).json({ ok: false, error: 'unknown product' });
    return r(req, res, next);
  });
  outer._backfillDone = Promise.all(Object.values(routers).map((r) => r._backfillDone));
  return outer;
}

module.exports = { createUpdateRouter, canonicalName, evolveCanonicalName, cmp3, parse3, readPublishedManifest, VARIANT_DEFS, EVOLVE_VARIANT_DEFS, PRODUCTS };

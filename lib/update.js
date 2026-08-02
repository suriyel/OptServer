'use strict';
// update.js —— 应用自动更新发布面（客户端设计：TechDemos docs/APP-AUTO-UPDATE-DESIGN.md §5/§7）。
//
// 免鉴权（lib/auth.js 门禁白名单放行，与 POST /v1/events 同档——客户端没有账号，内网即信任）：
//   GET /v1/update/latest            → 200 manifest | 204（尚无已发布版本；不是 404，避免与路由错误混淆）
//   GET /v1/update/download/:file    → res.sendFile（原生支持 Range → 断点续传白拿）
// 鉴权内（运维动作；上传/发布/下架/删草稿另加 requireAdmin——任何人都能推包等于任何人都能给全公司装东西）：
//   POST   /v1/update/upload?variant=&version=   raw stream 上传（不经 json body parser，边写边算 sha256）
//   GET    /v1/update/drafts                     草稿区就位情况 + 当前已发布
//   POST   /v1/update/publish                    { version, notes, minSupported }，服务端自检通过才移入发布区
//   POST   /v1/update/unpublish                  下架/回滚到上一个已发布版本（或清空 → /latest 返 204）
//   DELETE /v1/update/draft/:version/:variant    删草稿
//
// 存储（文件系统而非 SQLite——与遥测库解耦，出事时运维可直接 cat/手改 index.json 救急）：
//   releases/
//   ├── index.json                { published: <manifest>|null, history: [<manifest>...] 最新在前 }
//   ├── staging/<ver>/<variant>.exe + <variant>.json（{originalName,size,sha256,uploadedAt} 边车）
//   └── published/<ver>/cancong-portable-<ver>[-with-linux].exe   ← 保留最近 3 个版本供回滚，更旧自动清理
//
// 命名归一：上传落盘即抛弃原始名（含空格的「cancong Portable 0.0.4.exe」），发布时统一成无空格
// slug（规避 URL 编码问题）；客户端只认 manifest 里的 packages[variant].file，绝不自己拼文件名。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { requireAdmin } = require('./auth');

const VARIANTS = ['slim', 'with-linux'];
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

function canonicalName(version, variant) {
  return variant === 'with-linux'
    ? `cancong-portable-${version}-with-linux.exe`
    : `cancong-portable-${version}.exe`;
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

function createUpdateRouter(opts) {
  opts = opts || {};
  const ROOT = opts.releasesDir || path.join(__dirname, '..', 'releases');
  const nowFn = opts.nowFn || (() => new Date());
  const stagingDir = (ver) => path.join(ROOT, 'staging', ver);
  const publishedDir = (ver) => path.join(ROOT, 'published', ver);
  const indexFile = () => path.join(ROOT, 'index.json');

  function readIndex() {
    try {
      const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
      return { published: j.published || null, history: Array.isArray(j.history) ? j.history : [] };
    } catch (_) { return { published: null, history: [] }; }
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

  // ---- 免鉴权面 ----

  router.get('/update/latest', (req, res) => {
    const { published } = readIndex();
    if (!published) return res.status(204).end();
    res.json(published);
  });

  router.get('/update/download/:file', (req, res) => {
    const file = String(req.params.file || '');
    const { published } = readIndex();
    if (!FILE_RE.test(file) || !published) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }
    const hit = Object.values(published.packages || {}).some((p) => p && p.file === file);
    const abs = path.join(publishedDir(published.version), file);
    if (!hit || !fs.existsSync(abs)) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }
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
    const finalPath = path.join(dir, variant + '.exe');
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
        if (sc && fs.existsSync(path.join(stagingDir(ver), va + '.exe'))) variants[va] = sc;
      }
      if (Object.keys(variants).length) drafts.push({ version: ver, variants });
    }
    res.json({ ok: true, data: {
      published: idx.published
        ? { version: idx.published.version, pubDate: idx.published.pubDate, minSupported: idx.published.minSupported || '' }
        : null,
      history: idx.history.slice(0, KEEP_PUBLISHED).map((m) => ({ version: m.version, pubDate: m.pubDate })),
      drafts,
    } });
  });

  // 发布前服务端自检（任一不过拒绝并说明；「发布」按钮的真正把关在这里，前端只做提示）：
  //   1. 两个变体都在草稿区；2. 版本号合法三段数字且高于当前已发布；
  //   3. 落盘文件大小与边车一致、sha256 复算一致；4. minSupported 为空或合法且 <= version。
  router.post('/update/publish', requireAdmin, async (req, res) => {
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
    for (const va of VARIANTS) {
      const exe = path.join(stagingDir(version), va + '.exe');
      const sc = readSidecar(version, va);
      if (!sc || !fs.existsSync(exe)) {
        return res.status(400).json({ ok: false, error: `草稿区缺 ${va} 变体（两个变体都齐才可发布——只发一个会让另一变体用户静默停更）` });
      }
      let st;
      try { st = fs.statSync(exe); } catch (_) { return res.status(400).json({ ok: false, error: `读 ${va} 失败` }); }
      if (st.size !== sc.size) return res.status(400).json({ ok: false, error: `${va} 文件大小与上传记录不一致（${st.size} ≠ ${sc.size}）` });
      let sha;
      try { sha = await sha256File(exe); } catch (_) { return res.status(500).json({ ok: false, error: `${va} sha256 复算失败` }); }
      if (sha !== sc.sha256) return res.status(400).json({ ok: false, error: `${va} sha256 复算不一致（落盘后被改动？请重新上传）` });
      packages[va] = { file: canonicalName(version, va), size: st.size, sha256: sha };
    }
    // 自检全过 → staging rename 进 published/<ver>/（同卷 rename，快）
    try {
      fs.mkdirSync(publishedDir(version), { recursive: true });
      for (const va of VARIANTS) {
        fs.renameSync(path.join(stagingDir(version), va + '.exe'),
          path.join(publishedDir(version), packages[va].file));
      }
      fs.rmSync(stagingDir(version), { recursive: true, force: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: '移入发布区失败：' + e.message });
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
    res.json({ ok: true, data: { published: manifest } });
  });

  // 下架/回滚：删当前版本文件，回退到上一个文件仍在的已发布版本；没有则清空（/latest → 204）
  router.post('/update/unpublish', requireAdmin, (req, res) => {
    const idx = readIndex();
    if (!idx.published) return res.status(400).json({ ok: false, error: '当前没有已发布版本' });
    const dropped = idx.published.version;
    try { fs.rmSync(publishedDir(dropped), { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    idx.history = idx.history.filter((m) => m.version !== dropped);
    idx.published = idx.history.find((m) => fs.existsSync(publishedDir(m.version))) || null;
    writeIndex(idx);
    res.json({ ok: true, data: {
      dropped,
      published: idx.published ? { version: idx.published.version } : null,
    } });
  });

  router.delete('/update/draft/:version/:variant', requireAdmin, (req, res) => {
    const ver = String(req.params.version || '');
    const va = String(req.params.variant || '');
    if (!parse3(ver) || !VARIANTS.includes(va)) return res.status(400).json({ ok: false, error: 'bad params' });
    const exe = path.join(stagingDir(ver), va + '.exe');
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

module.exports = { createUpdateRouter, canonicalName, cmp3, parse3 };

'use strict';
// update-archive.test.js —— 发布时派生 tar.gz（lib/archive-derive.js + lib/update.js 接线）：
// 派生成功进 manifest / 下载路由放行 archive / 派生产物能被真 tar 解开（writer 反向对拍）/
// 派生失败不阻断发布且留痕（响应 + drafts）。
//
// 真派生需要 7z 二进制：OPS_7Z_BIN 或兄弟仓 TechDemos tools/7z/7zr.exe（gitignored 缓存），
// 都没有则相关用例 skip（fail-open 用例不需要 7z，恒跑）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const express = require('express');

const { makeApp, postJson, getJson, listenApp } = require('./helpers');
const { createUpdateRouter } = require('../lib/update');

const SEVEN_ZIP = process.env.OPS_7Z_BIN
  || ['D:/03PyDemo/TechDemos/tools/7z/7zr.exe', path.join(__dirname, '..', 'tools', '7z', process.platform === 'win32' ? '7zr.exe' : '7zz')]
    .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } })
  || null;
const SKIP_7Z = SEVEN_ZIP ? false : '无 7z 二进制（设 OPS_7Z_BIN 或缓存 tools/7z）';
const HAS_TAR = (() => { try { return !spawnSync('tar', ['--version'], { stdio: 'ignore' }).error; } catch (_) { return false; } })();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ops-arc-'));

async function login(baseUrl) {
  const r = await postJson(baseUrl, '/v1/auth/login', { username: 'admin', password: 'admin123' });
  assert.strictEqual(r.status, 200);
  return r.json.data.token;
}

async function upload(baseUrl, token, version, variant, buf, filename) {
  const fn = encodeURIComponent(filename);
  const res = await fetch(`${baseUrl}/v1/update/upload?variant=${variant}&version=${version}&filename=${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer ' + token },
    body: buf,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function publish(baseUrl, token, body) {
  const res = await fetch(baseUrl + '/v1/update/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 造一个「SFX 形态」夹具：任意前缀字节 + 真 7z 归档（7z 系工具按签名扫描定位归档，前缀无关紧要
// ——与真便携包同构：stub + 配置 + 归档）。内容含长路径文件，逼出 tar writer 的 GNU L 支。
const LONG_REL = 'resources/app.asar.unpacked/node_modules/some-very-long-package-name-for-testing/prebuilds/win32-x64/a-subdirectory-with-long-name/deep-binary-file.node';
function makeSfxLikeFixture() {
  const base = tmp();
  const src = path.join(base, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'cancong.exe'), 'v-exe-bytes');
  fs.mkdirSync(path.join(src, 'resources'));
  fs.writeFileSync(path.join(src, 'resources', 'app.asar'), 'v-asar-bytes');
  fs.mkdirSync(path.join(src, path.dirname(LONG_REL)), { recursive: true });
  fs.writeFileSync(path.join(src, LONG_REL), 'deep-bytes');
  // ★ 通配必须走绝对路径：7z 对绝对 `dir\*` 剥父目录（条目从 cancong.exe 起），对相对 `src\*`
  //   反而保留 src\ 前缀——build-portable.cjs 用的是绝对路径，夹具必须同形，否则派生出的 tar
  //   会多一层目录（真机实测差异）。
  const r = spawnSync(SEVEN_ZIP, ['a', '-mx=1', path.join(base, 'payload.7z'), path.join(src, '*')], { cwd: base, stdio: 'ignore' });
  assert.strictEqual(r.status, 0, '7z 打夹具归档必须成功');
  return Buffer.concat([Buffer.from('FAKE-SFX-STUB-PREFIX-BYTES'), fs.readFileSync(path.join(base, 'payload.7z'))]);
}

test('派生成功：manifest 带 archive、下载路由放行、tar.gz 能被真 tar 解开（writer 反向对拍）', { skip: SKIP_7Z || (HAS_TAR ? false : '需系统 tar 做反向对拍') }, async (t) => {
  process.env.OPS_7Z_BIN = SEVEN_ZIP; // resolve7z 第一优先级；本用例进程内设置即可
  const { baseUrl } = await makeApp(t, { auth: true });
  const token = await login(baseUrl);
  const exe = makeSfxLikeFixture();
  assert.strictEqual((await upload(baseUrl, token, '0.0.9', 'slim', exe, 'cancong-portable-0.0.9.exe')).status, 200);
  assert.strictEqual((await upload(baseUrl, token, '0.0.9', 'with-linux', exe, 'cancong-portable-0.0.9-with-linux.exe')).status, 200);

  const pub = await publish(baseUrl, token, { version: '0.0.9', notes: 'n' });
  assert.strictEqual(pub.status, 200);
  assert.deepStrictEqual(pub.json.data.archiveDerive, { slim: { ok: true }, 'with-linux': { ok: true } }, '发布响应留痕派生结果');

  const latest = await getJson(baseUrl, '/v1/update/latest');
  assert.strictEqual(latest.status, 200);
  for (const [va, gz] of [['slim', 'cancong-portable-0.0.9.tar.gz'], ['with-linux', 'cancong-portable-0.0.9-with-linux.tar.gz']]) {
    const a = latest.json.packages[va].archive;
    assert.ok(a, `packages.${va}.archive 在场`);
    assert.strictEqual(a.file, gz, '归档名走 canonical 规则');
    assert.match(String(a.sha256), /^[0-9a-f]{64}$/);
    assert.ok(a.size > 0 && a.unpackedSize > 0, 'size/unpackedSize 都得有（客户端磁盘预检要用）');
  }

  // 下载路由放行 + 字节 sha 与 manifest 一致
  const a = latest.json.packages.slim.archive;
  const res = await fetch(`${baseUrl}/v1/update/download/${a.file}`);
  assert.strictEqual(res.status, 200, '★ 漏放 archive = 客户端下载 404 → 静默回落执行 exe（§3.5 点名坑）');
  const gzBuf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(gzBuf.length, a.size);
  assert.strictEqual(sha256(gzBuf), a.sha256);

  // 反向对拍：自写 tar writer 的产物必须能被系统 tar 解开，长路径条目一个不丢
  const out = tmp();
  fs.writeFileSync(path.join(out, 'a.tar.gz'), gzBuf);
  fs.mkdirSync(path.join(out, 'x'));
  execSync('tar -xzf a.tar.gz -C x', { cwd: out, stdio: 'ignore' });
  assert.strictEqual(fs.readFileSync(path.join(out, 'x', 'cancong.exe'), 'utf8'), 'v-exe-bytes');
  assert.strictEqual(fs.readFileSync(path.join(out, 'x', 'resources', 'app.asar'), 'utf8'), 'v-asar-bytes');
  assert.strictEqual(fs.readFileSync(path.join(out, 'x', LONG_REL), 'utf8'), 'deep-bytes', '超 100 字节路径（GNU L）不丢');

  // drafts 留痕：两变体 archives 均 true
  const drafts = await fetch(baseUrl + '/v1/update/drafts', { headers: { authorization: 'Bearer ' + token } });
  const dj = await drafts.json();
  assert.deepStrictEqual(dj.data.published.archives, { slim: true, 'with-linux': true });
});

test('启动补派生 backfill：exe-only 旧 manifest 部署新代码重启即自愈（免重发布）+ 幂等 + 空库 no-op', { skip: SKIP_7Z }, async (t) => {
  process.env.OPS_7Z_BIN = SEVEN_ZIP;
  const ROOT = tmp();
  const exe = makeSfxLikeFixture();
  const pubDir = path.join(ROOT, 'published', '0.0.9');
  fs.mkdirSync(pubDir, { recursive: true });
  const packages = {};
  for (const [va, file] of [['slim', 'cancong-portable-0.0.9.exe'], ['with-linux', 'cancong-portable-0.0.9-with-linux.exe']]) {
    fs.writeFileSync(path.join(pubDir, file), exe);
    packages[va] = { file, size: exe.length, sha256: sha256(exe) }; // 刻意无 archive——模拟旧代码发布的 manifest
  }
  const manifest = { schemaVersion: 1, version: '0.0.9', pubDate: '2026-08-07T00:00:00Z', notes: '', minSupported: '', packages };
  fs.writeFileSync(path.join(ROOT, 'index.json'), JSON.stringify({ published: manifest, history: [manifest] }, null, 2));

  const r1 = createUpdateRouter({ releasesDir: ROOT });
  await r1._backfillDone;
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
  for (const [va, gz] of [['slim', 'cancong-portable-0.0.9.tar.gz'], ['with-linux', 'cancong-portable-0.0.9-with-linux.tar.gz']]) {
    const a = idx.published.packages[va].archive;
    assert.ok(a, `backfill 后 packages.${va}.archive 在场`);
    assert.strictEqual(a.file, gz, '归档名走 canonical 规则');
    assert.ok(a.size > 0 && a.unpackedSize > 0);
    assert.ok(fs.existsSync(path.join(pubDir, gz)), 'tar.gz 落盘在发布目录（下载路由同目录取件）');
    assert.ok(idx.history[0].packages[va].archive, 'history 同版本条目一并补齐（保持与 published 一致）');
  }

  // /latest 出口直接可见——客户端零操作自愈
  const app = express();
  app.use('/v1', r1);
  const { baseUrl } = await listenApp(t, app);
  const latest = await getJson(baseUrl, '/v1/update/latest');
  assert.strictEqual(latest.status, 200);
  assert.ok(latest.json.packages.slim.archive, '/latest 带 archive');
  const dl = await fetch(`${baseUrl}/v1/update/download/${latest.json.packages.slim.archive.file}`);
  assert.strictEqual(dl.status, 200, '补派生的 tar.gz 同样过下载路由命中面');

  // 幂等：第二次启动（archive 已在 index）不重复派生——哨兵字节不被覆盖
  const gzPath = path.join(pubDir, 'cancong-portable-0.0.9.tar.gz');
  fs.writeFileSync(gzPath, 'SENTINEL');
  const r2 = createUpdateRouter({ releasesDir: ROOT });
  await r2._backfillDone;
  assert.strictEqual(fs.readFileSync(gzPath, 'utf8'), 'SENTINEL', '★ archive 已登记 → 跳过，绝不重复派生');

  // 无 published → 零成本 no-op（连 index.json 都不建）
  const emptyRoot = tmp();
  const r3 = createUpdateRouter({ releasesDir: emptyRoot });
  await r3._backfillDone;
  assert.ok(!fs.existsSync(path.join(emptyRoot, 'index.json')), '空库不写 index');
});

test('派生失败（上传物不是 SFX）：发布照常、响应/drafts 留痕、manifest 无 archive', async (t) => {
  process.env.OPS_7Z_BIN = SEVEN_ZIP || path.join(tmp(), 'no-such-7z.exe'); // 7z 在场时靠假 SFX 触发失败；不在场时靠解析失败
  const { baseUrl } = await makeApp(t, { auth: true });
  const token = await login(baseUrl);
  const junk = crypto.randomBytes(4096); // 不含 7z 签名 → 解不出
  assert.strictEqual((await upload(baseUrl, token, '0.0.9', 'slim', junk, 'cancong-portable-0.0.9.exe')).status, 200);
  assert.strictEqual((await upload(baseUrl, token, '0.0.9', 'with-linux', junk, 'cancong-portable-0.0.9-with-linux.exe')).status, 200);

  const pub = await publish(baseUrl, token, { version: '0.0.9' });
  assert.strictEqual(pub.status, 200, '★ 派生失败绝不阻断发布（一个 7z 依赖没配好不能卡住全公司发版）');
  assert.strictEqual(pub.json.data.archiveDerive.slim.ok, false);
  assert.ok(pub.json.data.archiveDerive.slim.error, '失败原因必须给出');

  const latest = await getJson(baseUrl, '/v1/update/latest');
  assert.strictEqual(latest.status, 200);
  assert.ok(!latest.json.packages.slim.archive, 'manifest 无 archive → 客户端自动回落执行道');

  const drafts = await fetch(baseUrl + '/v1/update/drafts', { headers: { authorization: 'Bearer ' + token } });
  const dj = await drafts.json();
  assert.deepStrictEqual(dj.data.published.archives, { slim: false, 'with-linux': false }, '发布页能看见「本次没有解压道」');
});

'use strict';
// update-linux.test.js —— 内网 feed 挂蚕丛 Linux 独立版包（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §11.3 D3）：
// Linux 变体可选（两个 exe 照旧必需）/ 进 manifest、不派生解压道 / 能下载 / 架构槽与 gzip 头自检 / 启动补派生跳过 Linux。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const { makeApp, postJson, getJson } = require('./helpers');
const { createUpdateRouter } = require('../lib/update');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function login(baseUrl) {
  const r = await postJson(baseUrl, '/v1/auth/login', { username: 'admin', password: 'admin123' });
  return r.json.data.token;
}
async function upload(baseUrl, token, version, variant, buf, filename) {
  const res = await fetch(`${baseUrl}/v1/update/upload?variant=${variant}&version=${version}&filename=${encodeURIComponent(filename)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer ' + token }, body: buf,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function publish(baseUrl, token, version) {
  const res = await fetch(baseUrl + '/v1/update/publish', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ version, notes: '', minSupported: '' }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function stageExe(baseUrl, token, v) {
  assert.strictEqual((await upload(baseUrl, token, v, 'slim', crypto.randomBytes(512), 'orig.exe')).status, 200);
  assert.strictEqual((await upload(baseUrl, token, v, 'with-linux', crypto.randomBytes(512), 'orig2.exe')).status, 200);
}
const gz = () => zlib.gzipSync(crypto.randomBytes(2048));

test('不带 Linux 包照常发布：manifest 只有两个 exe 变体', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const tok = await login(baseUrl);
  await stageExe(baseUrl, tok, '1.0.1');
  const r = await publish(baseUrl, tok, '1.0.1');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(Object.keys(r.json.data.published.packages).sort(), ['slim', 'with-linux']);
});

test('带 Linux 包：进 manifest（规范名、sha）、不派生解压道、可下载；草稿区列出', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const tok = await login(baseUrl);
  await stageExe(baseUrl, tok, '1.0.2');
  const buf = gz();
  assert.strictEqual((await upload(baseUrl, tok, '1.0.2', 'linux-x64', buf, 'cancong-server-1.0.2-linux-x64.tar.gz')).status, 200);
  const drafts = (await fetch(baseUrl + '/v1/update/drafts', { headers: { authorization: 'Bearer ' + tok } }).then((x) => x.json())).data;
  assert.ok(drafts.drafts[0].variants['linux-x64'], '草稿区要看得到 Linux 包');
  const r = await publish(baseUrl, tok, '1.0.2');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const p = r.json.data.published.packages['linux-x64'];
  assert.deepStrictEqual([p.file, p.size, p.sha256, p.archive], ['cancong-server-1.0.2-linux-x64.tar.gz', buf.length, sha256(buf), undefined]);
  assert.ok(!('linux-x64' in r.json.data.archiveDerive), 'Linux 包不走 7z 派生');
  const dl = await fetch(baseUrl + '/v1/update/download/' + p.file);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(sha256(Buffer.from(await dl.arrayBuffer())), sha256(buf));
  const latest = await getJson(baseUrl, '/v1/update/latest');
  assert.ok(latest.json.packages['linux-x64'], '/latest 带 Linux 条目（Windows 客户端只读自己的 key）');
});

test('Linux 包自检：传错架构槽 ⇒ 400；不是 gzip ⇒ 400', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const tok = await login(baseUrl);
  await stageExe(baseUrl, tok, '1.0.3');
  await upload(baseUrl, tok, '1.0.3', 'linux-arm64', gz(), 'cancong-server-1.0.3-linux-x64.tar.gz');
  const a = await publish(baseUrl, tok, '1.0.3');
  assert.strictEqual(a.status, 400);
  assert.match(a.json.error, /linux-arm64.*架构 x64/);
  await upload(baseUrl, tok, '1.0.3', 'linux-arm64', crypto.randomBytes(256), 'cancong-server-1.0.3-linux-arm64.tar.gz');
  const b = await publish(baseUrl, tok, '1.0.3');
  assert.strictEqual(b.status, 400);
  assert.match(b.json.error, /不是 gzip/);
});

test('缺必需的 exe 变体仍拒发（Linux 包在也不行）', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const tok = await login(baseUrl);
  await upload(baseUrl, tok, '1.0.4', 'slim', crypto.randomBytes(512), 'orig.exe');
  await upload(baseUrl, tok, '1.0.4', 'linux-x64', gz(), 'cancong-server-1.0.4-linux-x64.tar.gz');
  const r = await publish(baseUrl, tok, '1.0.4');
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /with-linux/);
});

test('启动补派生跳过 Linux 包（它本来就是 tar.gz，别拿 7z 去解）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-lnx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = 'cancong-server-2.0.0-linux-x64.tar.gz';
  fs.mkdirSync(path.join(dir, 'published', '2.0.0'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'published', '2.0.0', file), gz());
  const man = { schemaVersion: 1, version: '2.0.0', pubDate: 'x', notes: '', minSupported: '', packages: { 'linux-x64': { file, size: 1, sha256: 'x' } } };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ published: man, history: [man] }));
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try { await createUpdateRouter({ releasesDir: dir })._backfillDone; } finally { console.log = orig; }
  assert.ok(!logs.some((l) => /补派生.*linux-x64/.test(l)), logs.join('\n'));
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.strictEqual(after.published.packages['linux-x64'].archive, undefined);
});

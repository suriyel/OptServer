'use strict';
// update-hardening.test.js —— 更新发布面缺口补齐（2026-08-04 自动升级验证）：
// 上传健壮性（空 body / 中断清理）/ 管理动作 403 矩阵 / 并发竞态（publish check-then-act）/
// 生命周期保留策略（KEEP_PUBLISHED prune、连环 unpublish 到 prune 边界、HISTORY_CAP）。
// 与 update.test.js 互补：那边是主链路，这边是边界与故障面。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { makeApp, postJson, getJson, makeEvent } = require('./helpers');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function login(baseUrl, username, password) {
  const r = await postJson(baseUrl, '/v1/auth/login', {
    username: username || 'admin', password: password || 'admin123',
  });
  assert.strictEqual(r.status, 200);
  return r.json.data.token;
}

async function upload(baseUrl, token, version, variant, buf, filename) {
  const fn = encodeURIComponent(filename == null ? 'orig name.exe' : filename);
  const res = await fetch(`${baseUrl}/v1/update/upload?variant=${variant}&version=${version}&filename=${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer ' + token },
    body: buf,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function stageBoth(baseUrl, token, version, buf) {
  assert.strictEqual((await upload(baseUrl, token, version, 'slim', buf)).status, 200);
  assert.strictEqual((await upload(baseUrl, token, version, 'with-linux', buf)).status, 200);
}

async function publish(baseUrl, token, body) {
  const res = await fetch(baseUrl + '/v1/update/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 独立临时 releasesDir（需要直查落盘状态的用例用它）
function tempReleasesDir(t) {
  const rel = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-rel-'));
  t.after(() => fs.rmSync(rel, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return rel;
}

// 轮询等待条件成立（Windows 下流关闭/清理是异步的，不能只看一眼）
async function eventually(fn, timeoutMs, what) {
  const deadline = Date.now() + (timeoutMs || 2000);
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) assert.fail('超时未达成：' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- 上传健壮性 ----

test('上传：空 body → 400，staging 不留任何文件（含 .uploading 临时件与边车）', async (t) => {
  const rel = tempReleasesDir(t);
  const { baseUrl } = await makeApp(t, { auth: true, releasesDir: rel });
  const token = await login(baseUrl);

  const r = await upload(baseUrl, token, '0.0.1', 'slim', Buffer.alloc(0));
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /empty/);

  const staging = path.join(rel, 'staging', '0.0.1');
  await eventually(() => {
    const names = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
    return names.length === 0;
  }, 2000, '空 body 后 staging/0.0.1 应为空（不留 .uploading/边车）');
});

test('上传：客户端中途断连 → .uploading 临时件必须清理（不残留半截包）', async (t) => {
  const rel = tempReleasesDir(t);
  const { baseUrl } = await makeApp(t, { auth: true, releasesDir: rel });
  const token = await login(baseUrl);
  const u = new URL(baseUrl);

  // 手写 http 请求：声明 4MB 只发 64KB 就断——fetch 不给这种控制粒度
  await new Promise((resolve) => {
    const req = http.request({
      host: u.hostname, port: u.port, method: 'POST',
      path: '/v1/update/upload?variant=slim&version=0.0.2&filename=x.exe',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': 4 * 1024 * 1024,
        authorization: 'Bearer ' + token,
      },
    });
    req.on('error', () => resolve()); // 断连本身会在客户端冒 ECONNRESET，属预期
    req.write(crypto.randomBytes(64 * 1024), () => {
      setTimeout(() => { req.destroy(); resolve(); }, 50); // 让服务端先收到首块再断
    });
  });

  const staging = path.join(rel, 'staging', '0.0.2');
  await eventually(() => {
    const names = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
    return !names.some((n) => n.endsWith('.uploading')) && !names.includes('slim.exe');
  }, 3000, '断连后 .uploading 临时件应被清理且不产出正式包');

  // 断连不留后遗症：同 (version,variant) 重传照常成功
  const buf = crypto.randomBytes(1024);
  const again = await upload(baseUrl, token, '0.0.2', 'slim', buf);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.data.sha256, sha256(buf));
});

// ---- 管理动作 403 矩阵（update.test.js 只测了 upload 的 403）----

test('403 矩阵：publish/unpublish/删草稿 对普通用户一律 403；drafts 只读面登录即可见', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const admin = await login(baseUrl);

  // 预置一个普通用户
  const mk = await fetch(baseUrl + '/v1/auth/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin },
    body: JSON.stringify({ username: 'ops-user', password: 'user123' }),
  });
  assert.strictEqual(mk.status, 200);
  const user = await login(baseUrl, 'ops-user', 'user123');

  // 备一份可发布的草稿（管理员操作）
  await stageBoth(baseUrl, admin, '0.0.1', crypto.randomBytes(1024));

  // 管理动作 × 普通用户 → 403，且动作未生效
  assert.strictEqual((await publish(baseUrl, user, { version: '0.0.1' })).status, 403, 'publish');
  assert.strictEqual((await fetch(baseUrl + '/v1/update/latest')).status, 204, '403 的 publish 不得生效');
  const un = await fetch(baseUrl + '/v1/update/unpublish', {
    method: 'POST', headers: { authorization: 'Bearer ' + user },
  });
  assert.strictEqual(un.status, 403, 'unpublish');
  const del = await fetch(baseUrl + '/v1/update/draft/0.0.1/slim', {
    method: 'DELETE', headers: { authorization: 'Bearer ' + user },
  });
  assert.strictEqual(del.status, 403, '删草稿');
  const drafts = await fetch(baseUrl + '/v1/update/drafts', { headers: { authorization: 'Bearer ' + user } });
  assert.strictEqual(drafts.status, 200, 'drafts 是只读面：登录即可见（管理动作另有 requireAdmin）');
  assert.strictEqual((await drafts.json()).data.drafts[0].version, '0.0.1', '草稿未被 403 的删除动过');

  // 未登录 × 管理动作 → 401（全局门禁挡在 requireAdmin 之前）
  assert.strictEqual((await postJson(baseUrl, '/v1/update/publish', { version: '0.0.1' })).status, 401);
  assert.strictEqual((await fetch(baseUrl + '/v1/update/unpublish', { method: 'POST' })).status, 401);
  assert.strictEqual((await fetch(baseUrl + '/v1/update/draft/0.0.1/slim', { method: 'DELETE' })).status, 401);
});

// ---- 并发竞态（publish 是「读 index → await sha 复算 → 写 index」的 check-then-act）----

test('并发 publish 两个版本：history 不得丢版本，latest 必须落在高版本上', async (t) => {
  const rel = tempReleasesDir(t);
  const { baseUrl } = await makeApp(t, { auth: true, releasesDir: rel });
  const token = await login(baseUrl);

  // 两个版本各自双变体就位；包给大一点（256KB）让 sha 复算的 await 窗口真实存在
  await stageBoth(baseUrl, token, '0.0.1', crypto.randomBytes(256 * 1024));
  await stageBoth(baseUrl, token, '0.0.2', crypto.randomBytes(256 * 1024));

  // 同时发出两个 publish（不 await 中间态，让两个请求都先过版本检查再进 sha 复算）
  const [r1, r2] = await Promise.all([
    publish(baseUrl, token, { version: '0.0.1' }),
    publish(baseUrl, token, { version: '0.0.2' }),
  ]);
  // 串行化后合法结局只有两种：都 200（先 0.0.1 后 0.0.2），或 0.0.2 先落地导致 0.0.1 被「版本须更高」拒掉
  assert.ok(r1.status === 200 || r1.status === 400, '0.0.1: 200 或被版本检查拒绝，不允许 5xx/挂死');
  assert.strictEqual(r2.status, 200, '0.0.2 必须发布成功');

  const idx = JSON.parse(fs.readFileSync(path.join(rel, 'index.json'), 'utf8'));
  assert.strictEqual(idx.published.version, '0.0.2', 'latest 必须是高版本——绝不允许低版本后写覆盖');
  if (r1.status === 200) {
    const vers = idx.history.map((m) => m.version).sort();
    assert.deepStrictEqual(vers, ['0.0.1', '0.0.2'], '两个都发布成功时 history 不得丢版本');
  }
  // 发布区文件与 manifest 对得上：当前版本可下载
  const dl = await fetch(baseUrl + '/v1/update/download/cancong-portable-0.0.2.exe');
  assert.strictEqual(dl.status, 200);
});

test('publish 进行中并发同版本 upload：结局无论谁赢，服务端不崩、发布面自洽', async (t) => {
  const rel = tempReleasesDir(t);
  const { baseUrl } = await makeApp(t, { auth: true, releasesDir: rel });
  const token = await login(baseUrl);

  await stageBoth(baseUrl, token, '0.0.1', crypto.randomBytes(256 * 1024));
  const [pub, up] = await Promise.all([
    publish(baseUrl, token, { version: '0.0.1' }),
    upload(baseUrl, token, '0.0.1', 'slim', crypto.randomBytes(256 * 1024)),
  ]);
  // upload 结局不锁死（先后交叠允许 200 或 5xx），但服务端必须活着且发布面自洽
  assert.ok([200, 400, 500].includes(up.status), 'upload 不允许挂死无响应');
  if (pub.status === 200) {
    const latest = await fetch(baseUrl + '/v1/update/latest');
    assert.strictEqual(latest.status, 200);
    const m = await latest.json();
    const dl = await fetch(baseUrl + '/v1/update/download/' + m.packages.slim.file);
    assert.strictEqual(dl.status, 200, '发布成功则 manifest 里的文件必须真实可下载');
    assert.strictEqual((await dl.arrayBuffer()).byteLength, m.packages.slim.size, '字节数与 manifest 一致');
  }
});

// ---- 生命周期保留策略（KEEP_PUBLISHED=3 / HISTORY_CAP=50 —— lib/update.js 顶部常量）----

test('保留策略：发到第 4 版时最旧版本文件目录被 prune，history 元数据仍全量', async (t) => {
  const rel = tempReleasesDir(t);
  const { baseUrl } = await makeApp(t, { auth: true, releasesDir: rel });
  const token = await login(baseUrl);

  for (const v of ['0.0.1', '0.0.2', '0.0.3', '0.0.4']) {
    await stageBoth(baseUrl, token, v, crypto.randomBytes(1024));
    assert.strictEqual((await publish(baseUrl, token, { version: v })).status, 200);
  }
  const dirs = fs.readdirSync(path.join(rel, 'published')).sort();
  assert.deepStrictEqual(dirs, ['0.0.2', '0.0.3', '0.0.4'], '只保留最近 KEEP_PUBLISHED=3 个版本的文件');
  const idx = JSON.parse(fs.readFileSync(path.join(rel, 'index.json'), 'utf8'));
  assert.deepStrictEqual(idx.history.map((m) => m.version), ['0.0.4', '0.0.3', '0.0.2', '0.0.1'],
    'history 元数据不随文件 prune 裁剪（只受 HISTORY_CAP 约束）');
  // 被 prune 版本从此不可回滚到——文件已不在
  assert.strictEqual(fs.existsSync(path.join(rel, 'published', '0.0.1')), false);
});

test('保留策略：连环 unpublish 到 prune 边界——回滚保命线只有 KEEP_PUBLISHED-1 步深', async (t) => {
  const rel = tempReleasesDir(t);
  const { baseUrl } = await makeApp(t, { auth: true, releasesDir: rel });
  const token = await login(baseUrl);
  const unpub = async () => {
    const r = await fetch(baseUrl + '/v1/update/unpublish', {
      method: 'POST', headers: { authorization: 'Bearer ' + token },
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  for (const v of ['0.0.1', '0.0.2', '0.0.3', '0.0.4']) {
    await stageBoth(baseUrl, token, v, crypto.randomBytes(1024));
    assert.strictEqual((await publish(baseUrl, token, { version: v })).status, 200);
  }
  // 0.0.1 的文件已被 prune。回滚链：0.0.4 → 0.0.3 → 0.0.2 → (0.0.1 文件不在) → 清空
  let r = await unpub();
  assert.strictEqual(r.json.data.published.version, '0.0.3');
  r = await unpub();
  assert.strictEqual(r.json.data.published.version, '0.0.2');
  r = await unpub();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.published, null, '0.0.1 文件已被 prune → 跳过它直接清空，绝不发一个下载必 404 的版本');
  assert.strictEqual((await fetch(baseUrl + '/v1/update/latest')).status, 204);
});

test('保留策略：history 超 HISTORY_CAP=50 时裁最旧的元数据，最新在前', async (t) => {
  const rel = tempReleasesDir(t);
  const { baseUrl } = await makeApp(t, { auth: true, releasesDir: rel });
  const token = await login(baseUrl);

  // 直接种 50 条 history（发 51 个真版本太慢；readIndex 每请求现读，落盘即生效）
  const mk = (v) => ({ schemaVersion: 1, version: v, pubDate: '2026-08-01T00:00:00.000Z', notes: '', minSupported: '', packages: {} });
  const seeded = [];
  for (let i = 50; i >= 1; i--) seeded.push(mk('0.0.' + i)); // 0.0.50 最新在前
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, 'index.json'), JSON.stringify({ published: mk('0.0.50'), history: seeded }));

  await stageBoth(baseUrl, token, '0.1.0', crypto.randomBytes(1024));
  assert.strictEqual((await publish(baseUrl, token, { version: '0.1.0' })).status, 200);

  const idx = JSON.parse(fs.readFileSync(path.join(rel, 'index.json'), 'utf8'));
  assert.strictEqual(idx.history.length, 50, '51 条裁回 HISTORY_CAP=50');
  assert.strictEqual(idx.history[0].version, '0.1.0', '最新在前');
  assert.strictEqual(idx.history.some((m) => m.version === '0.0.1'), false, '裁掉的是最旧那条');
  assert.strictEqual(idx.published.version, '0.1.0');
});

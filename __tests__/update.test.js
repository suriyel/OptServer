'use strict';
// update.test.js —— 应用自动更新发布面（lib/update.js）：
// 上传幂等 / 发布自检拒绝 / latest 204 / 路径穿越防护 / Range 下载 / 下架回滚 /
// 门禁白名单（免鉴权查版下载 vs 管理动作 requireAdmin）/ update_apply ingest 聚合。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { makeApp, postJson, getJson, makeEvent } = require('./helpers');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function login(baseUrl) {
  const r = await postJson(baseUrl, '/v1/auth/login', { username: 'admin', password: 'admin123' });
  assert.strictEqual(r.status, 200);
  return r.json.data.token;
}

async function upload(baseUrl, token, version, variant, buf) {
  const res = await fetch(`${baseUrl}/v1/update/upload?variant=${variant}&version=${version}&filename=orig name.exe`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer ' + token },
    body: buf,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function stageBoth(baseUrl, token, version, slimBuf, linuxBuf) {
  assert.strictEqual((await upload(baseUrl, token, version, 'slim', slimBuf)).status, 200);
  assert.strictEqual((await upload(baseUrl, token, version, 'with-linux', linuxBuf || slimBuf)).status, 200);
}

async function publish(baseUrl, token, body) {
  const res = await fetch(baseUrl + '/v1/update/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('latest：尚无发布 → 204（不是 404）；免鉴权（门禁开启时无凭据可达）', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const res = await fetch(baseUrl + '/v1/update/latest');
  assert.strictEqual(res.status, 204);
  // 对照：同为 GET 的管理端 drafts 未登录 → 401（白名单只放 latest/download）
  assert.strictEqual((await getJson(baseUrl, '/v1/update/drafts')).status, 401);
});

test('上传：非法参数 400、非管理员 403、幂等重传覆盖', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const token = await login(baseUrl);
  const b1 = crypto.randomBytes(1024);
  const b2 = crypto.randomBytes(2048);

  assert.strictEqual((await upload(baseUrl, token, '0.0.4', 'nope', b1)).status, 400, '未知变体');
  assert.strictEqual((await upload(baseUrl, token, 'v0.4', 'slim', b1)).status, 400, '非法版本');

  // 非管理员（普通用户）→ 403
  await postJson(baseUrl, '/v1/auth/users', null); // 占位：无凭据 401 不影响下一步
  const mk = await fetch(baseUrl + '/v1/auth/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ username: 'ops-user', password: 'user123' }),
  });
  assert.strictEqual(mk.status, 200);
  const utoken = (await postJson(baseUrl, '/v1/auth/login', { username: 'ops-user', password: 'user123' })).json.data.token;
  assert.strictEqual((await upload(baseUrl, utoken, '0.0.4', 'slim', b1)).status, 403);

  // 首传 → 记录 size/sha；同 (version,variant) 重传 → 直接覆盖（幂等，「传错了重传」）
  const r1 = await upload(baseUrl, token, '0.0.4', 'slim', b1);
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.json.data.sha256, sha256(b1));
  const r2 = await upload(baseUrl, token, '0.0.4', 'slim', b2);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.data.size, 2048);
  assert.strictEqual(r2.json.data.sha256, sha256(b2));
  const drafts = await fetch(baseUrl + '/v1/update/drafts', { headers: { authorization: 'Bearer ' + token } });
  const dj = await drafts.json();
  assert.strictEqual(dj.data.drafts[0].variants.slim.sha256, sha256(b2), '草稿区以最后一次上传为准');
  assert.strictEqual(dj.data.drafts[0].variants.slim.originalName, 'orig name.exe');
});

test('发布自检：缺变体/版本不升/地板非法 一律拒绝；全过则 latest 出 manifest', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const token = await login(baseUrl);
  const slim = crypto.randomBytes(4096);
  const linux = crypto.randomBytes(8192);

  // 只传一个变体 → 拒绝（防「两变体只传了一半」的静默停更窗口）
  assert.strictEqual((await upload(baseUrl, token, '0.0.1', 'slim', slim)).status, 200);
  const only1 = await publish(baseUrl, token, { version: '0.0.1', notes: '', minSupported: '' });
  assert.strictEqual(only1.status, 400);
  assert.match(only1.json.error, /with-linux/);

  assert.strictEqual((await upload(baseUrl, token, '0.0.1', 'with-linux', linux)).status, 200);
  // 地板高于发布版本 → 拒绝
  assert.strictEqual((await publish(baseUrl, token, { version: '0.0.1', minSupported: '0.0.2' })).status, 400);
  // 非法版本 → 拒绝
  assert.strictEqual((await publish(baseUrl, token, { version: 'abc' })).status, 400);

  // 全过 → latest 200，文件名归一为无空格 slug，sha/size 一致
  const ok = await publish(baseUrl, token, { version: '0.0.1', notes: '第一版', minSupported: '' });
  assert.strictEqual(ok.status, 200);
  const latest = await fetch(baseUrl + '/v1/update/latest');
  assert.strictEqual(latest.status, 200);
  const m = await latest.json();
  assert.strictEqual(m.schemaVersion, 1);
  assert.strictEqual(m.version, '0.0.1');
  assert.strictEqual(m.notes, '第一版');
  assert.deepStrictEqual(m.packages.slim, { file: 'cancong-portable-0.0.1.exe', size: 4096, sha256: sha256(slim) });
  assert.strictEqual(m.packages['with-linux'].file, 'cancong-portable-0.0.1-with-linux.exe');

  // 版本不升（重发同版本）→ 拒绝
  await stageBoth(baseUrl, token, '0.0.1', slim, linux);
  assert.strictEqual((await publish(baseUrl, token, { version: '0.0.1' })).status, 400);
});

test('发布自检：sha 复算不一致拒绝（显式 releasesDir 直改落盘文件）', async (t) => {
  const os = require('os');
  const rel = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-rel-'));
  t.after(() => fs.rmSync(rel, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const { baseUrl } = await makeApp(t, { auth: true, releasesDir: rel });
  const token = await login(baseUrl);
  const slim = crypto.randomBytes(4096);
  await stageBoth(baseUrl, token, '0.0.1', slim);
  // 同长度篡改：size 检查过、sha 复算必须拦住
  const staged = path.join(rel, 'staging', '0.0.1', 'slim.exe');
  const evil = Buffer.from(fs.readFileSync(staged));
  evil[0] = evil[0] ^ 0xff;
  fs.writeFileSync(staged, evil);
  const r = await publish(baseUrl, token, { version: '0.0.1' });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /sha256/);
});

test('下载：命中清单 200、Range 206 断点续传、路径穿越/未发布文件 404', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const token = await login(baseUrl);
  const slim = crypto.randomBytes(4096);
  const linux = crypto.randomBytes(8192);
  await stageBoth(baseUrl, token, '0.0.1', slim, linux);
  assert.strictEqual((await publish(baseUrl, token, { version: '0.0.1' })).status, 200);

  // 免鉴权全量下载，字节一致
  const full = await fetch(baseUrl + '/v1/update/download/cancong-portable-0.0.1.exe');
  assert.strictEqual(full.status, 200);
  assert.strictEqual(sha256(Buffer.from(await full.arrayBuffer())), sha256(slim));

  // Range → 206 partial（客户端 .part 断点续传白拿）
  const part = await fetch(baseUrl + '/v1/update/download/cancong-portable-0.0.1.exe', {
    headers: { Range: 'bytes=1024-' },
  });
  assert.strictEqual(part.status, 206);
  const got = Buffer.from(await part.arrayBuffer());
  assert.strictEqual(got.length, 4096 - 1024);
  assert.strictEqual(sha256(got), sha256(slim.subarray(1024)));

  // 路径穿越（编码的 ../）与清单外文件 → 404
  assert.strictEqual((await fetch(baseUrl + '/v1/update/download/..%2Findex.json')).status, 404);
  assert.strictEqual((await fetch(baseUrl + '/v1/update/download/index.json')).status, 404);
  assert.strictEqual((await fetch(baseUrl + '/v1/update/download/no-such.exe')).status, 404);
});

test('下架/回滚：回退到上一个已发布版本；清空后 latest 回 204', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const token = await login(baseUrl);
  const bufA = crypto.randomBytes(1024);
  const bufB = crypto.randomBytes(1024);
  await stageBoth(baseUrl, token, '0.0.1', bufA);
  assert.strictEqual((await publish(baseUrl, token, { version: '0.0.1' })).status, 200);
  await stageBoth(baseUrl, token, '0.0.2', bufB);
  assert.strictEqual((await publish(baseUrl, token, { version: '0.0.2', minSupported: '0.0.2' })).status, 200);

  const un1 = await fetch(baseUrl + '/v1/update/unpublish', {
    method: 'POST', headers: { authorization: 'Bearer ' + token },
  });
  assert.strictEqual(un1.status, 200);
  const j1 = await un1.json();
  assert.strictEqual(j1.data.dropped, '0.0.2');
  assert.strictEqual(j1.data.published.version, '0.0.1');
  const latest1 = await fetch(baseUrl + '/v1/update/latest');
  assert.strictEqual((await latest1.json()).version, '0.0.1');
  // 被下架版本的包不再可下载
  assert.strictEqual((await fetch(baseUrl + '/v1/update/download/cancong-portable-0.0.2.exe')).status, 404);

  const un2 = await fetch(baseUrl + '/v1/update/unpublish', {
    method: 'POST', headers: { authorization: 'Bearer ' + token },
  });
  assert.strictEqual(un2.status, 200);
  assert.strictEqual((await fetch(baseUrl + '/v1/update/latest')).status, 204, '清空后回 204');
  // 再下架 → 400（已无发布）
  const un3 = await fetch(baseUrl + '/v1/update/unpublish', {
    method: 'POST', headers: { authorization: 'Bearer ' + token },
  });
  assert.strictEqual(un3.status, 400);
});

test('删草稿：存在删除成功、不存在 404', async (t) => {
  const { baseUrl } = await makeApp(t, { auth: true });
  const token = await login(baseUrl);
  await upload(baseUrl, token, '0.0.9', 'slim', crypto.randomBytes(64));
  const del = await fetch(baseUrl + '/v1/update/draft/0.0.9/slim', {
    method: 'DELETE', headers: { authorization: 'Bearer ' + token },
  });
  assert.strictEqual(del.status, 200);
  const del2 = await fetch(baseUrl + '/v1/update/draft/0.0.9/slim', {
    method: 'DELETE', headers: { authorization: 'Bearer ' + token },
  });
  assert.strictEqual(del2.status, 404);
});

test('ingest：update_apply 进 KNOWN_TYPES；ok:false 落 daily_fail（update:<reason>）并进失败页 recent；ok:true 只存原始', async (t) => {
  const { localDay } = require('../lib/time-utils');
  const NOW = new Date('2026-07-02T12:00:00+08:00');
  const day = localDay(NOW); // 归日随部署机 TZ（与生产同口径），不硬编码
  const { baseUrl, dao } = await makeApp(t, { nowFn: () => NOW });
  const r = await postJson(baseUrl, '/v1/events', { events: [
    makeEvent({ eventId: 'up-1', type: 'update_apply', appVersion: '0.0.4',
      payload: { from: '0.0.3', to: '0.0.4', variant: 'slim', ok: false, reason: 'other_instance', attempts: 3 } }),
    makeEvent({ eventId: 'up-2', type: 'update_apply', appVersion: '0.0.4',
      payload: { from: '0.0.3', to: '0.0.4', variant: 'slim', ok: true, attempts: 1 } }),
  ] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.accepted, 2);

  const kinds = dao.qFailureKinds(day, day);
  assert.deepStrictEqual(kinds, [{ kind: 'update:other_instance', n: 1 }], '仅 ok:false 计入失败聚合');

  const stats = await getJson(baseUrl, `/v1/stats/failures?from=${day}&to=${day}`);
  assert.strictEqual(stats.status, 200);
  const recent = stats.json.data.recent;
  assert.strictEqual(recent.length, 1, 'ok:true 不进失败列表');
  assert.strictEqual(recent[0].type, 'update_apply');
  assert.strictEqual(recent[0].payload.reason, 'other_instance');
});

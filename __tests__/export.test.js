'use strict';
// export.test.js —— CSV 导出：csv.js 转义/BOM 单元 + 四端点内容/表头/行数 + 范围校验 + 失败突破100条上限

const test = require('node:test');
const assert = require('node:assert');

const { makeApp, makeEvent } = require('./helpers');
const { ingestBatch } = require('../lib/ingest');
const { toCsv } = require('../lib/csv');
const { localDay } = require('../lib/time-utils');

const NOW = new Date(2026, 6, 2, 12, 0, 0);   // 本地 2026-07-02 12:00
const D1 = new Date(2026, 5, 30, 12, 0, 0);   // 2026-06-30
const D2 = new Date(2026, 6, 1, 12, 0, 0);    // 2026-07-01

const A = { installId: 'inst-A', user: 'userA', host: 'HOST-A', appVersion: '1.4.0' };
const B = { installId: 'inst-B', user: 'userB', host: 'HOST-B', appVersion: '1.3.0' };

// D1: A 完整会话 + A 一次 wf-1 done；D2: A wf-1 失败事件 + B 会话；NOW: A 开会话
function seed(dao) {
  ingestBatch(dao, [
    makeEvent({ ...A, type: 'session_start', payload: { tool: 'claude' } }),
    makeEvent({ ...A, type: 'session_end', payload: { tool: 'claude', durationMs: 10000, inputTokens: 100, outputTokens: 200 } }),
    makeEvent({ ...A, type: 'bp_run_end', payload: { status: 'done', blueprintId: 'wf-1', activeMs: 5000, inputTokens: 40, outputTokens: 60 } }),
  ], D1);
  ingestBatch(dao, [
    makeEvent({ ...A, type: 'failure_event', payload: { source: 'error_autoresume', kind: 'rate_limit', reason: '触发限流', blueprintId: 'wf-1' } }),
    makeEvent({ ...B, type: 'session_start', payload: { tool: 'codex' } }),
  ], D2);
  ingestBatch(dao, [
    makeEvent({ ...A, type: 'session_start', payload: { tool: 'claude' } }),
  ], NOW);
}

async function seededApp(t) {
  const h = await makeApp(t, { nowFn: () => NOW });
  seed(h.dao);
  return h;
}

// CSV 文本 → 去 BOM、按 CRLF 切、去空行（种子数据不含内嵌换行，朴素切分足够）
function csvLines(text) {
  return text.replace(/^﻿/, '').split('\r\n').filter((l) => l.length > 0);
}
// 取原始字节：fetch().text() 会在 UTF-8 解码时吞掉行首 BOM，故 BOM 断言走 bytes；
// text 用 TextDecoder（同样吞 BOM）解出正文供表头/行数断言。真实下载(attachment)保留 BOM 字节。
async function getCsv(baseUrl, p) {
  const res = await fetch(baseUrl + p);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type'),
    bytes, text: new TextDecoder('utf-8').decode(bytes) };
}

const range = () => `?from=${localDay(D1)}&to=${localDay(NOW)}`;

// ---- csv.js 单元 ----

test('csv：BOM 前缀 + 逗号/引号/换行转义 + 空 rows 只输出表头', () => {
  const cols = [{ key: 'a', header: '名称' }, { key: 'b', header: '值' }];
  const csv = toCsv(cols, [{ a: 'x,y', b: '含"引号"' }, { a: '换\n行', b: null }]);
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF);           // 首字符是 BOM
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  assert.strictEqual(lines[0], '名称,值');                  // 中文表头
  assert.strictEqual(lines[1], '"x,y","含""引号"""');       // 逗号→包裹；内部 " 翻倍
  assert.strictEqual(lines[2], '"换\n行",');                // 换行→包裹；null→空串

  const empty = toCsv(cols, []);
  assert.deepStrictEqual(empty.replace(/^﻿/, '').split('\r\n').filter((l) => l), ['名称,值']);
});

// ---- 端点：响应头 + 表头 + 行数 ----

test('export/blueprints：text/csv + BOM + 中文表头 + 行数与工作流数一致', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { status, contentType, bytes, text } = await getCsv(baseUrl, '/v1/export/blueprints' + range());
  assert.strictEqual(status, 200);
  assert.match(contentType, /text\/csv/);
  assert.deepStrictEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]); // 响应字节含 UTF-8 BOM
  const lines = csvLines(text);
  assert.match(lines[0], /^工作流,运行,成功,/);
  assert.strictEqual(lines.length, 2);                     // 表头 + wf-1 一行
  assert.match(lines[1], /^wf-1,1,1,/);                    // runs=1, runsDone=1
});

test('export/users：全部用户 + 全部指标列（不受 Top10 限制）', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { status, text } = await getCsv(baseUrl, '/v1/export/users' + range());
  assert.strictEqual(status, 200);
  const lines = csvLines(text);
  assert.match(lines[0], /^用户,主机,会话数,run数,失败数,活跃时长ms,输入Token,输出Token,Token合计$/);
  assert.strictEqual(lines.length, 3);                     // 表头 + userA + userB
  assert.ok(lines.some((l) => l.startsWith('userA,HOST-A,')));
  assert.ok(lines.some((l) => l.startsWith('userB,HOST-B,')));
});

test('export/failures：拍平 payload 明细 + 完整原因', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { status, text } = await getCsv(baseUrl, '/v1/export/failures' + range());
  assert.strictEqual(status, 200);
  const lines = csvLines(text);
  assert.match(lines[0], /^时间,用户,主机,工作流,来源,类型,原因,版本,事件ID$/);
  assert.strictEqual(lines.length, 2);                     // 表头 + 1 条失败
  assert.ok(lines[1].includes('rate_limit'));
  assert.ok(lines[1].includes('触发限流'));
  assert.ok(lines[1].includes('wf-1'));
});

test('export/installs：无范围恒 200 + 全部实例 + 今日文件名头', async (t) => {
  const { baseUrl } = await seededApp(t);
  const { status, text } = await getCsv(baseUrl, '/v1/export/installs');
  assert.strictEqual(status, 200);
  const lines = csvLines(text);
  assert.match(lines[0], /^用户,主机,版本,平台,渠道,活动会话,最后在线,首次上线,实例ID$/);
  assert.strictEqual(lines.length, 3);                     // 表头 + inst-A + inst-B
});

// ---- 范围校验 ----

test('export：非法/倒置范围 → 400（installs 无范围恒 200）', async (t) => {
  const { baseUrl } = await seededApp(t);
  for (const v of ['blueprints', 'users', 'failures']) {
    const { status } = await getCsv(baseUrl, `/v1/export/${v}?from=2026-07-10&to=2026-07-01`);
    assert.strictEqual(status, 400, v + ' 应 400');
  }
  const bad = await getCsv(baseUrl, '/v1/export/blueprints?from=not-a-date&to=2026-07-01');
  assert.strictEqual(bad.status, 400);
  const inst = await getCsv(baseUrl, '/v1/export/installs?from=2026-07-10&to=2026-07-01');
  assert.strictEqual(inst.status, 200);                    // installs 忽略范围参数
});

// ---- 失败导出突破 100 条上限（对比 stats /failures recent 只回 100） ----

test('export/failures：突破页面 100 条上限，导出范围内全部失败', async (t) => {
  const h = await makeApp(t, { nowFn: () => NOW });
  const batch = [];
  for (let i = 0; i < 150; i++) {
    batch.push(makeEvent({ ...A, type: 'failure_event',
      payload: { source: 'error', kind: 'k' + i, reason: 'r' + i } }));
  }
  ingestBatch(h.dao, batch, D2);

  const exp = await getCsv(h.baseUrl, '/v1/export/failures' + range());
  assert.strictEqual(csvLines(exp.text).length, 1 + 150);  // 表头 + 150 条，全部导出

  const stats = await fetch(h.baseUrl + '/v1/stats/failures' + range()).then((r) => r.json());
  assert.strictEqual(stats.data.recent.length, 100);       // 对照：stats recent 仍钳 100
});

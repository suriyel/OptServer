'use strict';
// time-utils.js —— 本地时区时间助手（拷自主仓库 server-config/time-utils.js，保持同源语义）。
//
// 存储层一律用 ISO-8601 UTC（new Date().toISOString()，带 Z）——可排序、无歧义、
// Date.parse 可还原。「给人看的边界」与 day 归日切分用本机本地时区（部署机钉 TZ=Asia/Shanghai）。
// day 归日的唯一来源是 localDay(now)：ingest 写入时算一次、固化为 events.day 列，
// 此后聚合/清理/查询只用该列，绝不从 ISO 串再推导（substr 得 UTC 日会错归，'localtime' 会随 TZ 漂移）。
//
// 命名约定：localXxx 一律返回「本地时区」串；带 Z 的 ISO 串只在存储层出现，不经此处。

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// 本地日 YYYY-MM-DD（要求传入 Date）。events.day / daily_* 的 day 列共用此口径。
function localDay(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// day 串加减 N 天：用 UTC 正午锚点做纯日历运算，与本机时区无关（stats 范围、job 窗口共用）
function shiftDay(day, deltaDays) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// 注：后端只需 localDay（day 归日）与 shiftDay（日历运算）。展示层格式化在前端
// public/js/core/fmt.js（ISO 存储、本地展示），后端不做人读时间串，故不携带 localStamp/localFromIso 等。
module.exports = { pad2, localDay, shiftDay };

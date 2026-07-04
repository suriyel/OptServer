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

// 本地时刻 YYYY-MM-DD HH:mm:ss（默认当前时刻）。日志行 / 诊断用。
function localStamp(d) {
  d = d || new Date();
  return localDay(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// 把已存储的 ISO（或任意 Date 可解析输入）转本地 YYYY-MM-DD HH:mm 展示串。
// 坏输入兜底：尽力把原串去掉 T、截到分钟，绝不抛。
function localFromIso(iso) {
  if (iso == null || iso === '') return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
  return localDay(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// 本地日 YYYY-MM-DD，接受 ISO 串或 Date
// （先把 UTC ISO 转本地再取日，避免 UTC+8 的 22:00Z 被截成前一天）。
function localDate(v) {
  if (v == null || v === '') return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v).slice(0, 10);
  return localDay(d);
}

// day 串加减 N 天：用 UTC 正午锚点做纯日历运算，与本机时区无关（stats 范围、job 窗口共用）
function shiftDay(day, deltaDays) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

module.exports = { pad2, localDay, localStamp, localFromIso, localDate, shiftDay };

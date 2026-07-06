'use strict';
// csv.js —— CSV 序列化：UTF-8 BOM + RFC4180 转义 + CRLF 行尾，供 export 路由复用。
// BOM 让 Excel 双击直接按 UTF-8 打开（中文不乱码）；CRLF 是 Excel/记事本最稳的行尾。

const BOM = '﻿';

// 单元格转义：含 " , \r \n 时用双引号包裹并把内部 " 翻倍；null/undefined → 空串
function cell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// columns: [{ key, header, map? }]（map 优先于 key）；rows: 对象数组。返回带 BOM 的完整 CSV 文本。
function toCsv(columns, rows) {
  const head = columns.map((c) => cell(c.header)).join(',');
  const body = rows.map((r) =>
    columns.map((c) => cell(c.map ? c.map(r) : r[c.key])).join(',')).join('\r\n');
  return BOM + head + '\r\n' + (body ? body + '\r\n' : '');
}

module.exports = { toCsv };

'use strict';
// _openapi-mini.js —— 零依赖的 OpenAPI 子集校验（契约测试用；_ 前缀不进 glob）。
// 只认本仓需要的那几样：type（含数组形式与 null）、integer ⊂ number、enum、const、required、本地 $ref、items、
// 以及「严格键」：schema 声明了 properties 的对象，值里多出未声明的键即报错（桩写错字段名 / 套错一层这类错就靠它抓）；
// 裸 {type:'object'} 不限键。

function deref(doc, s) {
  let cur = s;
  for (let i = 0; cur && cur.$ref && i < 8; i++) {
    cur = String(cur.$ref).replace(/^#\//, '').split('/').reduce((o, k) => (o ? o[k] : undefined), doc);
  }
  return cur;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validate(doc, schema0, v, at, errs) {
  const s = deref(doc, schema0);
  if (!s || typeof s !== 'object') return errs;
  if (s.type !== undefined) {
    const want = [].concat(s.type);
    const got = typeOf(v);
    if (!want.includes(got) && !(got === 'integer' && want.includes('number'))) {
      errs.push(at + '：类型应为 ' + want.join('|') + '，实际 ' + got);
      return errs;
    }
  }
  if (s.const !== undefined && !same(s.const, v)) errs.push(at + '：应为常量 ' + JSON.stringify(s.const));
  if (Array.isArray(s.enum) && !s.enum.some((x) => same(x, v))) errs.push(at + '：不在枚举 ' + JSON.stringify(s.enum) + ' 内（' + JSON.stringify(v) + '）');
  if (typeOf(v) === 'object') {
    for (const r of s.required || []) if (!(r in v)) errs.push(at + '：缺必填字段 ' + r);
    if (s.properties) {
      for (const k of Object.keys(v)) {
        if (!(k in s.properties)) { errs.push(at + '.' + k + '：规格里没有这个字段'); continue; }
        validate(doc, s.properties[k], v[k], at + '.' + k, errs);
      }
    }
  }
  if (typeOf(v) === 'array' && s.items) v.forEach((x, i) => validate(doc, s.items, x, at + '[' + i + ']', errs));
  return errs;
}

function opOf(doc, method, template) {
  const item = doc.paths && doc.paths[template];
  return item ? item[method] : undefined;
}

const jsonSchema = (part) => part && part.content && part.content['application/json'] && part.content['application/json'].schema;

/** 记录 {method, template, status, resBody} 的响应是否落在规格里 → 错误数组。 */
function checkResponse(doc, rec) {
  const at = rec.method.toUpperCase() + ' ' + rec.template + ' → ' + rec.status;
  const op = opOf(doc, rec.method, rec.template);
  if (!op) return [at + '：规格里没有这个 op'];
  const resp = op.responses && deref(doc, op.responses[String(rec.status)]);
  if (!resp) return [at + '：状态码未在规格里声明'];
  const sch = jsonSchema(resp);
  return sch ? validate(doc, sch, rec.resBody, at, []) : [];
}

/** 记录 {method, template, query, body} 的请求是否落在规格里 → 错误数组（请求体同样严格键）。 */
function checkRequest(doc, rec) {
  const at = rec.method.toUpperCase() + ' ' + rec.template + '（请求）';
  const op = opOf(doc, rec.method, rec.template);
  if (!op) return [at + '：规格里没有这个 op'];
  const errs = [];
  const qp = (op.parameters || []).map((p) => deref(doc, p)).filter((p) => p.in === 'query');
  for (const k of Object.keys(rec.query || {})) if (!qp.some((p) => p.name === k)) errs.push(at + '：query ' + k + ' 未声明');
  for (const p of qp) if (p.required && !(p.name in (rec.query || {}))) errs.push(at + '：缺必填 query ' + p.name);
  const rb = op.requestBody && deref(doc, op.requestBody);
  const hasBody = rec.body !== undefined && !(typeOf(rec.body) === 'object' && !Object.keys(rec.body).length);
  if (rb && rb.required && !hasBody) errs.push(at + '：缺请求体');
  if (hasBody) {
    const sch = jsonSchema(rb);
    if (!rb) errs.push(at + '：规格不收请求体');
    else if (sch) validate(doc, sch, rec.body, at + ' body', errs);
  }
  return errs;
}

module.exports = { validate, checkResponse, checkRequest, opOf };

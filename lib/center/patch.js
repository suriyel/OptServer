'use strict';
// center/patch.js —— 中心合成补丁的哨兵格式 + 确定性套用 + 导出统一 diff。
//
// 合成输出**不用 JSON 装长正文**（TechDemos 自进化设计 §1.1「长正文塞 JSON → 静默全丢」），沿用客户端整合器的哨兵：
//   <<<SUMMARY>>>
//   一段话：改了什么、为什么
//   <<<FIND>>>
//   原文片段（须在当前 SKILL.md 里恰好出现一次）
//   <<<REPLACE>>>
//   新片段
//   …（FIND/REPLACE 可重复）
//   <<<END>>>
// 套用：LF 规范化后逐段替换；任一 FIND 出现次数 ≠ 1 ⇒ 整份判锚点失败（不做模糊匹配，宁拒勿错）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const M = { SUMMARY: '<<<SUMMARY>>>', FIND: '<<<FIND>>>', REPLACE: '<<<REPLACE>>>', END: '<<<END>>>' };
const MARK_RE = /^<<<(SUMMARY|FIND|REPLACE|END)>>>[ \t]*$/;

const lf = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n');
// 标记独占一行 ⇒ 片段 = 两个标记之间的行原样拼回（不 trim：空白也是锚点的一部分）
const seg = (lines) => lines.join('\n');

/** 解析哨兵 → { summary, hunks:[{find, replace}] } | null（结构不合法） */
function parseSynth(text) {
  const lines = lf(text).split('\n');
  let summary = null; const hunks = [];
  let cur = null; let buf = []; let ended = false;
  const flush = () => {
    if (cur === 'SUMMARY') summary = seg(buf).trim();
    else if (cur === 'FIND') hunks.push({ find: seg(buf), replace: null });
    else if (cur === 'REPLACE') {
      const h = hunks[hunks.length - 1];
      if (!h || h.replace !== null) return false;
      h.replace = seg(buf);
    }
    return true;
  };
  for (const line of lines) {
    const m = MARK_RE.exec(line);
    if (!m) { if (cur) buf.push(line); continue; }
    if (cur && flush() === false) return null;
    if (m[1] === 'END') { ended = true; cur = null; break; }
    if (m[1] === 'REPLACE' && cur !== 'FIND') return null;   // REPLACE 必须紧跟 FIND
    if (m[1] === 'FIND' && cur === 'FIND') return null;
    cur = m[1]; buf = [];
  }
  if (!ended) return null;
  if (!hunks.length || hunks.some((h) => !h.find || h.replace === null)) return null;
  return { summary: summary || '', hunks };
}

function count(hay, needle) {
  let n = 0; let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/** 在 base 上依次套 hunks → { ok:true, text } | { ok:false, failedAt } ；保留 base 的换行风格 */
function applyHunks(base, hunks) {
  const crlf = /\r\n/.test(String(base || ''));
  let text = lf(base);
  for (let i = 0; i < hunks.length; i++) {
    const f = lf(hunks[i].find); const r = lf(hunks[i].replace);
    if (!f || count(text, f) !== 1) return { ok: false, failedAt: i };
    text = text.replace(f, () => r);
  }
  return { ok: true, text: crlf ? text.replace(/\n/g, '\r\n') : text };
}

/** 序列化回哨兵（导出 / 测试夹具用） */
function formatSynth(summary, hunks) {
  const out = [M.SUMMARY, summary || ''];
  for (const h of hunks) out.push(M.FIND, h.find, M.REPLACE, h.replace);
  out.push(M.END);
  return out.join('\n') + '\n';
}

/**
 * 统一 diff（导出退化道，供目标仓 `git apply`）：借 `git diff --no-index`，异步、不阻塞事件循环。
 * files: [{ rel, before, after }]；rel 为相对目标仓根的路径（如 blueprints/X/skills/n/SKILL.md）。
 */
async function unifiedDiff(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-diff-'));
  try {
    let out = '';
    for (const f of files) {
      if (f.before === f.after) continue;
      const a = path.join(dir, 'old', f.rel); const b = path.join(dir, 'new', f.rel);
      fs.mkdirSync(path.dirname(a), { recursive: true }); fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.writeFileSync(a, f.before); fs.writeFileSync(b, f.after);
      const txt = await new Promise((resolve, reject) => {
        execFile('git', ['diff', '--no-index', '--no-color', '--', 'old/' + f.rel, 'new/' + f.rel],
          { cwd: dir, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            // 有差异时 git diff --no-index 退出码 1，这是正常结果
            if (err && err.code !== 1) return reject(err);
            resolve(stdout);
          });
      });
      out += txt.split('a/old/').join('a/').split('b/new/').join('b/');
    }
    return out;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* tmp */ }
  }
}

/** 版本号末位 +1（市场版本门：服务端不替你加，见 TechDemos marketplace.js _resolvePublishVersion） */
function bumpVersion(v) {
  const p = String(v || '0.0.0').split('.');
  if (!p.every((x) => /^\d+$/.test(x))) return null;
  p[p.length - 1] = String(Number(p[p.length - 1]) + 1);
  return p.join('.');
}

module.exports = { parseSynth, applyHunks, formatSynth, unifiedDiff, bumpVersion, MARKERS: M };

'use strict';
// archive-derive.js —— 发布时从便携 SFX exe 派生 tar.gz（TechDemos docs/APP-UPDATE-ARCHIVE-EXTRACT-DESIGN.md §3）。
//
// 为什么存在：客户端侧 `sfx_spawn_failed`（EDR/杀毒按身份拒跑刚下载的无签名 exe）无解，唯一出路是
// 把「执行下载的 exe」从升级路径上拿掉——客户端 ≥0.0.6 优先下载本文件派生的 tar.gz，用纯 Node 解压
// 覆盖（零 spawn）。上传产物仍是那个 exe，运维零感知；老客户端读不到 archive 字段，天然走原路。
//
// SFX exe = 可执行头(stub) + 配置 + 7z 归档：7z 系工具把它当归档直接解（实证见设计稿 §1）。
// tar+gzip 用纯 Node 自写（tar 是固定 512B 头的顺序格式）：不引 npm 依赖、mode 位自己控
// （with-linux 变体里有要在 Linux 上跑的部署产物）。
//
// 7z 二进制解析链（唯一外部依赖；解不到 → 派生失败 → 发布照常、manifest 无 archive，见 §3.3）：
//   OPS_7Z_BIN → tools/7z/ 下平台二进制 → PATH（7zz/7zr/7z）
//   Linux 部署机：`apt install p7zip-full`（提供 7z）或放一个 7zz 到 tools/7z/，或设 OPS_7Z_BIN。

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

function resolve7z(repoRoot) {
  const cands = [];
  if (process.env.OPS_7Z_BIN) cands.push(process.env.OPS_7Z_BIN);
  const toolsDir = path.join(repoRoot || path.join(__dirname, '..'), 'tools', '7z');
  cands.push(path.join(toolsDir, process.platform === 'win32' ? '7zr.exe' : '7zz'));
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* 继续 */ }
  }
  // PATH 探测：跑 --help 能起来即认
  for (const name of process.platform === 'win32' ? ['7z', '7zr'] : ['7zz', '7z', '7zr']) {
    try {
      const r = spawnSync(name, ['--help'], { stdio: 'ignore', timeout: 10_000 });
      if (!r.error) return name;
    } catch (_) { /* 继续 */ }
  }
  return null;
}

// ---- 纯 Node tar writer（USTAR + GNU longname 回落）----

function octal(n, len) {
  // len 含结尾 NUL：值占 len-1 位（八进制、前导 0），与 GNU tar 同形
  const s = Math.max(0, Math.floor(n)).toString(8);
  return s.padStart(len - 1, '0').slice(0, len - 1) + '\0';
}

function tarHeader({ name, size, mode, mtimeSec, typeflag, prefix }) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode & 0o7777, 8), 100);
  b.write(octal(0, 8), 108);            // uid
  b.write(octal(0, 8), 116);            // gid
  b.write(octal(size, 12), 124);
  b.write(octal(mtimeSec, 12), 136);
  b.write('        ', 148);             // chksum 先填空格再回填
  b.write(typeflag, 156);
  b.write('ustar\0', 257);              // magic
  b.write('00', 263);                   // version
  if (prefix) b.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

// 长名切分：整名 ≤100 直接放；否则找 '/' 切成 prefix(≤155)+name(≤100)；再不行返回 null（走 GNU 'L'）
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] === '/') {
      const prefix = name.slice(0, i);
      const rest = name.slice(i + 1);
      if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest.length) {
        return { name: rest, prefix };
      }
    }
  }
  return null;
}

function longLinkBlocks(name) {
  // GNU 'L'：先发一个名为 ././@LongLink 的头 + 数据区放完整名（NUL 结尾），再发截断的真头
  const data = Buffer.from(name + '\0', 'utf8');
  const head = tarHeader({ name: '././@LongLink', size: data.length, mode: 0, mtimeSec: 0, typeflag: 'L', prefix: '' });
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return [head, padded];
}

function headerFor(relName, st, isDir) {
  const name = isDir ? relName + '/' : relName;
  const base = {
    size: isDir ? 0 : st.size,
    mode: st.mode || (isDir ? 0o755 : 0o644),
    mtimeSec: Math.floor(st.mtimeMs / 1000),
    typeflag: isDir ? '5' : '0',
  };
  const split = splitName(name);
  if (split) return [tarHeader({ ...base, ...split })];
  return [...longLinkBlocks(name), tarHeader({ ...base, name: name.slice(0, 100), prefix: '' })];
}

function walk(dir, rel, out) {
  const names = fs.readdirSync(dir).sort();
  for (const n of names) {
    const abs = path.join(dir, n);
    const r = rel ? rel + '/' + n : n;
    const st = fs.statSync(abs);
    if (st.isDirectory()) { out.push({ abs, rel: r, st, dir: true }); walk(abs, r, out); }
    else if (st.isFile()) out.push({ abs, rel: r, st, dir: false });
    // 符号链/其他类型：win-unpacked 里不该出现，跳过（宁缺勿错）
  }
  return out;
}

/** 把 srcDir 打成 outPath（.tar.gz）。返回 { size, sha256, unpackedSize }。 */
async function tarGzDir(srcDir, outPath) {
  const entries = walk(srcDir, '', []);
  const gzip = zlib.createGzip({ level: 6 });
  const hash = crypto.createHash('sha256');
  let size = 0;
  let unpackedSize = 0;
  const out = fs.createWriteStream(outPath);
  gzip.on('data', (c) => { hash.update(c); size += c.length; });
  const done = pipeline(gzip, out);

  const write = (buf) => new Promise((res, rej) => { gzip.write(buf, (e) => (e ? rej(e) : res())); });
  for (const e of entries) {
    for (const h of headerFor(e.rel, e.st, e.dir)) await write(h);
    if (!e.dir) {
      unpackedSize += e.st.size;
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(e.abs);
        rs.on('data', (c) => gzip.write(c));
        rs.on('end', res);
        rs.on('error', rej);
        gzip.on('error', rej);
      });
      const pad = e.st.size % 512;
      if (pad) await write(Buffer.alloc(512 - pad));
    }
  }
  await write(Buffer.alloc(1024)); // 归档终止：两个全零块
  gzip.end();
  await done;
  return { size, sha256: hash.digest('hex'), unpackedSize };
}

/**
 * 从便携 SFX exe 派生 tar.gz。
 * @returns {Promise<{size:number, sha256:string, unpackedSize:number}>}
 * @throws 7z 缺失/解包失败/打包失败——调用方 fail-open（发布照常，只是没有 archive 字段）
 */
async function deriveArchive(exePath, outPath, opts) {
  const sevenZip = (opts && opts.sevenZip) || resolve7z(opts && opts.repoRoot);
  if (!sevenZip) throw new Error('7z 不可用（设 OPS_7Z_BIN 或安装 p7zip / 放置 tools/7z 二进制）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-derive-'));
  try {
    const r = spawnSync(sevenZip, ['x', '-y', '-o' + tmp, exePath], { stdio: 'ignore', timeout: 10 * 60 * 1000 });
    if (r.error) throw new Error('7z 执行失败: ' + r.error.message);
    if (r.status !== 0) throw new Error('7z 解包退出码 ' + r.status);
    // 解出来至少得有点东西（空目录 = exe 里根本没归档/格式不认识）
    if (!fs.readdirSync(tmp).length) throw new Error('7z 解出空目录（上传物不是 SFX 便携包？）');
    return await tarGzDir(tmp, outPath);
  } catch (e) {
    try { fs.rmSync(outPath, { force: true }); } catch (_) { /* best-effort */ }
    throw e;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

function canonicalArchiveName(version, variant) {
  return variant === 'with-linux'
    ? `cancong-portable-${version}-with-linux.tar.gz`
    : `cancong-portable-${version}.tar.gz`;
}

module.exports = { deriveArchive, canonicalArchiveName, resolve7z, tarGzDir };

#!/usr/bin/env node
'use strict';
// kit-sync.js —— 把 EvolveServer/kit/ 整目录同步进 vendor/svc-kit/（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §9）。
// kit 的真源在 EvolveServer 仓（它要外发；本仓不外发，只能单向消费）。**只在 EvolveServer 改 kit**，
// 本仓只跑这个脚本；__tests__/kit-parity.test.js 逐字节对拍，漂移就红。
// 定位：env EVOLVE_SERVER_DIR ▷ 同级 ../EvolveServer。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'vendor', 'svc-kit');

function evolveDir() {
  return process.env.EVOLVE_SERVER_DIR || path.resolve(ROOT, '..', 'EvolveServer');
}

function main() {
  const src = path.join(evolveDir(), 'kit');
  if (!fs.existsSync(src)) { console.error('找不到 ' + src + '（设 EVOLVE_SERVER_DIR 指向 EvolveServer 仓）'); return 1; }
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.cpSync(src, DEST, { recursive: true });
  console.log('已同步 ' + src + ' → ' + path.relative(ROOT, DEST));
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { evolveDir, DEST };

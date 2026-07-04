'use strict';
// vendor-uplot.js —— 把 uPlot 从 devDependency 拷入 public/vendor/ 并提交进 git：
// 运行时零新增依赖（"仅 2 个 dependencies"指 dependencies）；部署机 npm ci --omit=dev 也不缺文件。

const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'node_modules', 'uplot', 'dist');
const dstDir = path.join(__dirname, '..', 'public', 'vendor');

const FILES = ['uPlot.iife.min.js', 'uPlot.min.css'];

fs.mkdirSync(dstDir, { recursive: true });
for (const f of FILES) {
  fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
  console.log('[vendor] copied ' + f);
}
const ver = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'uplot', 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(dstDir, 'UPLOT-VERSION.txt'), 'uplot@' + ver + ' (MIT, https://github.com/leeoniya/uPlot)\n');
console.log('[vendor] uplot@' + ver);

'use strict';
// vendor-assets.js —— 把前端第三方产物从 devDependency 拷入 public/vendor/ 并提交进 git：
// 运行时零新增依赖（"仅 2 个 dependencies"指 dependencies）；部署机 npm ci --omit=dev 也不缺文件、不依赖外网。
//   · uPlot        —— 趋势时序图（轻量，40KB）
//   · ECharts      —— 排名条形 / 堆叠条形等图表控件（工作流页、用户页）
//   · IBM Plex Mono —— 仪表盘数字/标签等宽字体（离线安全，内网无外网亦可）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dst = path.join(ROOT, 'public', 'vendor');
const fontDst = path.join(dst, 'fonts');
fs.mkdirSync(fontDst, { recursive: true });

function copy(rel, toName, dir) {
  const src = path.join(ROOT, 'node_modules', rel);
  fs.copyFileSync(src, path.join(dir || dst, toName || path.basename(rel)));
  console.log('[vendor] ' + (toName || path.basename(rel)));
}
function ver(pkg) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version;
}

copy('uplot/dist/uPlot.iife.min.js');
copy('uplot/dist/uPlot.min.css');
copy('echarts/dist/echarts.min.js');
for (const w of [400, 500, 600]) {
  copy('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-' + w + '-normal.woff2',
    'ibm-plex-mono-' + w + '.woff2', fontDst);
}

fs.writeFileSync(path.join(dst, 'VENDOR.txt'),
  'uplot@' + ver('uplot') + ' (MIT, https://github.com/leeoniya/uPlot)\n'
  + 'echarts@' + ver('echarts') + ' (Apache-2.0, https://echarts.apache.org)\n'
  + '@fontsource/ibm-plex-mono@' + ver('@fontsource/ibm-plex-mono') + ' (OFL-1.1, IBM Plex Mono)\n');
console.log('[vendor] done');

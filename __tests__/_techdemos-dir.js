'use strict';
// _techdemos-dir.js —— 定位兄弟仓 TechDemos（跨仓契约用例用；_ 前缀不进 glob）。
// 设了 TECHDEMOS_DIR 就只认它（指错了要红给人看，不悄悄回落到同级目录）；没设才找同级 ../TechDemos。
// 与 TechDemos 那边 scripts/__tests__/_ops-server-dir.js 找本仓的套路对称。

const fs = require('fs');
const path = require('path');

function techdemosDir(marker) {
  const want = marker || path.join('api-spec', 'dist', 'openapi.json');
  const cands = process.env.TECHDEMOS_DIR ? [process.env.TECHDEMOS_DIR] : [path.join(__dirname, '..', '..', 'TechDemos')];
  const dir = cands.find((d) => fs.existsSync(path.join(d, want)));
  return { dir: dir || null, tried: cands.map((d) => path.join(d, want)) };
}

module.exports = { techdemosDir };

'use strict';
// kit 副本对拍（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §9）：vendor/svc-kit/ 必须与 EvolveServer/kit/ 逐字节一致
// （文件集合相同、内容相同）。真源在 EvolveServer（它外发，本仓不外发 ⇒ 只能单向消费）——
// 本仓直接改副本 / EvolveServer 改了 kit 没 sync，都在这里红：npm run kit:sync。
// 找不到 EvolveServer 仓 ⇒ 降级为 skip 并**明说没对拍**（不是「覆盖到了」）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { evolveDir, DEST } = require('../scripts/kit-sync');

function listFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}
// 比内容不比换行：Windows 开发机 core.autocrlf 可能把工作树写成 CRLF（两仓都是 eol=lf 入库）
const read = (p) => fs.readFileSync(p).toString('utf8').replace(/\r\n/g, '\n');

const SRC = path.join(evolveDir(), 'kit');
const HAS = fs.existsSync(SRC);

test('★ kit 副本与 EvolveServer/kit 逐字节一致', { skip: HAS ? false : '找不到 EvolveServer 仓（' + SRC + '）：kit 副本未对拍' }, () => {
  const a = listFiles(SRC); const b = listFiles(DEST);
  assert.deepStrictEqual(b, a, '文件集合不同：npm run kit:sync');
  const diff = a.filter((f) => read(path.join(SRC, f)) !== read(path.join(DEST, f)));
  assert.deepStrictEqual(diff, [], '内容漂移：只在 EvolveServer 改 kit，然后 npm run kit:sync');
});

---
name: review
description: 独立审查 — 对抗式审查本批每份合成补丁（防刷门、防过拟合、防冲突），落 output/review.json。
---

# 独立审查（本节点唯一职责）

你是**独立审查者**，不是合成者的帮手：默认怀疑，找出不该合入的理由。

逐个读 `output/synth/*.txt`（文件名去掉 `.txt` 就是 `ref`）。对每一份：

1. 找到对应簇的节点：已有簇 `c<id>` 查 `input/clusters.json`；新簇 `n<k>` 查 `output/assign.json` 的 `newClusters`。
2. 读该节点的上游基线 `input/base/<nodeId>/SKILL.md`，在脑中把 FIND → REPLACE 套上去，看改后的全文。
3. 逐项判，命中就记下对应标记：
   - `gate-weakening`：删掉或放宽了检查、验证、门禁、通过条件；把强制步骤改成可选；教模型绕过框架的拦截。
   - `overfit`：只对某个具体项目、语言、目录结构或工具成立，换个项目就错或无意义。
   - `conflict`：与这个 SKILL.md 其余部分矛盾、重复已有内容，或破坏了上下游节点依赖的产出约定。
4. 另外核一遍格式：FIND 是否真的在基线里逐字出现且唯一；不是就在 `notes` 里写明（运营看板也会再复核一次）。

没有任何标记、且你认为合入后这个节点会更好 ⇒ `pass: true`；否则 `pass: false`。

## 产出

写 **`output/review.json`**（数组，每份合成补丁一条；没有合成补丁就写 `[]`）：

```json
[
  { "ref": "c7", "pass": true, "flags": [], "notes": "一两句理由" },
  { "ref": "n1", "pass": false, "flags": ["overfit"], "notes": "把 pnpm 写死了，npm/yarn 项目不成立" }
]
```

`flags` 只能取上面三个标记；`notes` 用中文，写具体理由。写完：

{{ADVANCE_OK}}

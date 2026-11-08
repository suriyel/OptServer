---
name: cluster
description: 归簇 — 把本批新签名的补丁提案逐条并入已有簇或开新簇，落 output/assign.json。
---

# 归簇（本节点唯一职责）

工作目录下的输入由运营看板写好，**只读**：

- `input/manifest.json`：本批处理的工作流 id、上游版本、有基线的节点。
- `input/samples.jsonl`：每行一个**新签名**的代表提案（`ref` 形如 `s123`），含所属节点 `nodeId`、来自多少台机器、信号、`diff`（客户端在它本机版本上的 FIND/REPLACE 片段）与理由、证据摘录。
- `input/clusters.json`：这个工作流**已有的簇**（`ref` 形如 `c7`），每簇带几条代表成员的 diff 与理由；`status` 可能是 open / adopted / rejected / parked / pushed。

## 怎么判

逐条看样本，问一句：**它想对这个节点的技能做的改动，和某个已有簇说的是不是同一件事？**

- 「同一件事」= 同一节点、要解决的问题与改动意图相同，只是措辞、位置或细节不同。改的方向相反、或解决的是另一个问题，就不是同一件事。
- **只在同一节点内归簇**，绝不跨节点合并。
- 已裁决（adopted / rejected / parked / pushed）的簇**同样可以并入**——并进去只是给它加计数，不会再产补丁；这正是为了不让被驳回过的想法换个说法又开一个新簇。
- 找不到同一件事的已有簇 ⇒ 开新簇：在 `newClusters` 里登记 `{key, nodeId, title}`（`key` 用 `n1`、`n2`…；`title` 一句中文概括改动意图，≤40 字）。本批里多条新样本说的是同一件事，就归进同一个新簇。

## 产出

写 **`output/assign.json`**（目录已存在）：

```json
{
  "assignments": [
    { "sample": "s123", "cluster": "c7" },
    { "sample": "s124", "newKey": "n1" }
  ],
  "newClusters": [
    { "key": "n1", "nodeId": "build", "title": "提交前先跑一遍单测" }
  ]
}
```

- `samples.jsonl` 里**每个样本恰好出现一次**；漏掉的样本会被当作处理失败、下个窗口重来。
- `cluster` 只能填 `clusters.json` 里出现过的 `ref`；`newKey` 只能填 `newClusters` 里登记过的 `key`。
- 没有样本（只有待重新合成的簇）⇒ 写 `{"assignments": [], "newClusters": []}`。

写完：

{{ADVANCE_OK}}

输入缺失或读不了 → {{ADVANCE_FAIL notes=<写清缺了哪个文件>}}

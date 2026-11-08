# evolve-center —— 蓝图自进化中心批处理工作流

运营看板（OptServer）的自进化中心在每日窗口或「立即处理」时，经本机回环让同机蚕丛独立版**无头**跑本工作流：
`POST /_blueprint/run {cwd: <批目录>, blueprintId: 'evolve-center', fresh: true}`。
设计权威：TechDemos `docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md` §5.4。

- 本目录随 OptServer 发布；OptServer 处理队列前比对 `blueprint.json` 的 `version`，不一致就经
  `POST /_blueprint/import {source:{type:'local'}}` 重新装进同机蚕丛。**改了技能记得把 version 加一**。
- 一次 run 只处理**一个工作流**的一批新签名。不放 ask（无头会按推荐项代答）。
- 所有路径相对工作目录（cwd）。

## 输入契约（OptServer 写）

| 文件 | 内容 |
|---|---|
| `input/manifest.json` | `{schema:'evolve-center-input/1', blueprintId, baseVersion, nodes:[有基线的节点], samples, clusters}` |
| `input/samples.jsonl` | 每行一个新签名的代表样本：`{ref:'s<n>', signature, nodeId, count, machines, signal, diff, rationale, evidence:[{kind,text}]}`。`diff` 是客户端整合器在**它本机版本**上的 `--- FIND / +++ REPLACE` 片段 |
| `input/clusters.json` | 该工作流已有的簇（含已裁决的）：`[{ref:'c<id>', nodeId, title, status, resynth, summary, runs, machines, members:[{signature, signal, diff, rationale}]}]`；`status` ∈ open / adopted / rejected / parked / pushed |
| `input/base/<nodeId>/SKILL.md` | 当前**上游版本**（目标市场最新版；不在市场时为中心机本机版）的节点技能 |

## 输出契约（本工作流写，OptServer 读）

| 文件 | 节点 | 内容 |
|---|---|---|
| `output/assign.json` | cluster | `{assignments:[{sample:'s<n>', cluster:'c<id>'} 或 {sample, newKey:'n1'}], newClusters:[{key:'n1', nodeId, title}]}`；每个样本恰好一条 |
| `output/synth/<ref>.txt` | synthesize | 补丁哨兵（见下）；`<ref>` = 已有簇 `c<id>` 或新簇 `newKey` |
| `output/review.json` | review | `[{ref, pass:bool, flags:['gate-weakening'|'overfit'|'conflict'], notes}]` |

补丁哨兵（标记独占一行；FIND 须在 `input/base/<节点>/SKILL.md` 里**逐字恰好出现一次**；可多组 FIND/REPLACE）：

```
<<<SUMMARY>>>
一段话：改了什么、为什么（会进推送的提交说明）
<<<FIND>>>
原文片段
<<<REPLACE>>>
新片段
<<<END>>>
```

OptServer 入库时还会做确定性复核：FIND 套不上 ⇒ 标红 `anchor`；格式坏 ⇒ 标红 `format`；
**只有 status=open 的簇会落合成结果**（已裁决的簇即便被并入新样本也只加计数）。

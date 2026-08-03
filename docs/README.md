# cancong-ops 文档

蚕丛 harness 运营统计服务器的项目文档。快速上手见仓库根 [`../README.md`](../README.md)，需求与设计背景见 [`../OPS-TELEMETRY-DESIGN.md`](../OPS-TELEMETRY-DESIGN.md)。

## 索引

| 文档 | 面向 | 内容 |
|------|------|------|
| [API.md](./API.md) | 客户端 / 看板开发者 | 事件信封、上报接口、查询端点、CSV 导出、应用自动更新、错误响应——**双端唯一契约** |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 维护者 | 模块划分、存储 schema、索引设计、三个易错点解法、数据生命周期、看板与发布面 |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 运维 | 环境、env、systemd、schema 迁移、日志、健康检查、备份与发布区、故障排查、PG 迁移条件 |
| [CLIENT-HANDOFF.md](./CLIENT-HANDOFF.md) | 采集端(harness)开发者 | 客户端 server-telemetry 实现 & 联调清单：传输契约、事件/新字段来源、挂接点、开关、可靠性、联调步骤、验收 |
| [TIME-DIMENSION-PLAN.md](./TIME-DIMENSION-PLAN.md) | 维护者 | 看板时间维度三期设计留档：P1 逐日下钻+环比(已落地) / P2 沉默天数 / P3 作息分布——含每个分叉的取舍与放弃项 |
| [RELEASE-NOTES.md](./RELEASE-NOTES.md) | 全体 | 各版本变更记录 |

## 一分钟速览

```bash
npm ci && npm start        # 启动，默认 http://localhost:5900
curl localhost:5900/healthz            # 探活
node scripts/seed-demo.js --db ./data/ops.db   # 灌演示数据
npm test                   # 113 个单测
npm run bench              # 700 万行查询压测
npm run migrate -- --db ./data/ops.db          # 对已有库单独跑 schema 迁移（幂等）
```

技术形态：Node CJS 单进程 · express + better-sqlite3 两依赖 · 零构建 · 数据即单个 `.db` 文件。

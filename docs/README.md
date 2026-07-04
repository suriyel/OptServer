# cancong-ops 文档

蚕丛 harness 运营统计服务器的项目文档。快速上手见仓库根 [`../README.md`](../README.md)，需求与设计背景见 [`../OPS-TELEMETRY-DESIGN.md`](../OPS-TELEMETRY-DESIGN.md)。

## 索引

| 文档 | 面向 | 内容 |
|------|------|------|
| [API.md](./API.md) | 客户端 / 看板开发者 | 事件信封、上报接口、7 个查询端点、错误响应——**双端唯一契约** |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 维护者 | 模块划分、存储 schema、索引设计、三个易错点解法、数据生命周期 |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 运维 | 环境、env、systemd、日志、健康检查、备份、故障排查、PG 迁移条件 |
| [CLIENT-HANDOFF.md](./CLIENT-HANDOFF.md) | 采集端(harness)开发者 | 客户端 server-telemetry 实现 & 联调清单：传输契约、事件/新字段来源、挂接点、开关、可靠性、联调步骤、验收 |
| [RELEASE-NOTES.md](./RELEASE-NOTES.md) | 全体 | 各版本变更记录 |

## 一分钟速览

```bash
npm ci && npm start        # 启动，默认 http://localhost:5900
curl localhost:5900/healthz            # 探活
node scripts/seed-demo.js --db ./data/ops.db   # 灌演示数据
npm test                   # 49 个单测
npm run bench              # 700 万行查询压测
```

技术形态：Node CJS 单进程 · express + better-sqlite3 两依赖 · 零构建 · 数据即单个 `.db` 文件。

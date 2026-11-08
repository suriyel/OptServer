// @ts-check
// auth.js —— 重导出 kit 前端核心（vendor/svc-kit/ui/auth.js；真源 EvolveServer/kit，npm run kit:sync 同步）。
// 各页面照旧从 core/auth.js import，实现只有 kit 那一份（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §9）。
export * from '/vendor/svc-kit/ui/auth.js';

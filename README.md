# memlite-js

> TypeScript 实现的 memlite 核心——嵌入式本地记忆引擎。
> 与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust 单文件二进制）数据互通。

## 定位

把 memlite 的核心机制抽成 npm 包，供 DSH 插件及其他 AI 宿主直接 `import` 使用——**无子进程开销、库常驻内存、召回 1ms 级**。

## 包

| 包 | 说明 |
|---|---|
| [`@rsrsai/memlite`](./packages/core) | 核心库：Store / BM25 / 向量侧车 / 因果树 / 敏感闸 / 同步 / 嵌入抽象 |

## 文档

- [方案](./docs/proposal.md)——定位、技术选型、模块划分
- [计划](./docs/plan.md)——里程碑与任务拆解
- [互通契约](./docs/compat.md)——与 Rust memlite 的数据契约
- [嵌入档详设](./docs/embedding.md)——三档 provider 与密钥管理

## 快速开始

```bash
pnpm install
pnpm -C packages/core build
pnpm -C packages/core test
```

## 协议

MIT。本仓代码开源；用户的 `memory.jsonl` 是私有数据，不在此列。

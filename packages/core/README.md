# @rsrsai/memlite

> 可嵌入本地记忆引擎（TypeScript）。与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust 单文件二进制）**数据互通**。

## 定位

把 memlite 的核心记忆机制抽成 npm 包，供宿主插件（DSH / Kimi / ZCode / Codex 等）直接 `import`——**无子进程开销、库常驻内存、召回 1ms 级**。

- **可嵌入**：Node ≥ 18，主路径零外部依赖；多进程模式可选原生锁 `fs-ext`（可选 peer 依赖，未安装不影响单写者）
- **可互通**：与 Rust memlite 读写同一份 `memory.jsonl` / `emb.f32` / `config.json`（契约见 [compat](../../docs/compat.md)）
- **可渐进**：默认纯 BM25 零外网；嵌入档显式开启
- **可并发**：级别 0 多读单写、级别 1 本地多进程读写；NFS 探针就绪但未验收

## 安装

```bash
pnpm add @rsrsai/memlite
```

## 快速开始

```ts
import { Memlite } from '@rsrsai/memlite'

const mem = new Memlite({
  dataDir: '~/.memlite-data',        // 缺省走分层解析（env > 项目级 > 用户级 > ~/memlite-data）
  recallLimit: 10,
  sensitiveGate: true,               // 写前敏感扫描（默认开）
  embedding: { provider: 'none' },   // 默认纯 BM25；可选 'host' | 'openai-compatible'
})

await mem.open()

// 存（嵌入异步，失败不拦存入）
const id = await mem.remember('nginx 反代 504 超时。调大 timeout 解决。', { title: 'nginx 排查' })

// 检索（BM25 兜底，嵌入可用时 RRF 融合；项目级无命中回退用户级）
const r = await mem.recall('网关超时')
// r.backend: 'bm25' | 'rrf';  r.fallback: '' | 'user';  r.hits[].ancestors/children 因果视界

// 因果链
mem.chain(id, 3)          // 因链全文（根在前）+ 本条 + 果链下探 3 层
mem.tree({ depth: 3 })    // 因果树渲染

await mem.close()
```

## API 一览

| 类别 | API | 说明 |
|---|---|---|
| 存取 | `remember(content, opts)` | 存记忆；opts: title/tags/project/parent；敏感闸先跑 |
| | `update(id, patch)` | 就地改（同 id 追加新版本，父链/元数据随迁） |
| | `forget(id)` | 删（墓碑）；id/前 8 位/纲名皆可 |
| | `show(id)` / `list(limit)` | 看全文（带因果邻居）/ 列最近 |
| 检索 | `recall(query, opts)` | 主检索；写入 querylog；带因果视界 |
| | `resolveEmbedder()` | 嵌入档解析（none/host/openai-compatible） |
| | `reembed()` | 旧记忆批量回填向量 |
| 因果 | `attach/demote(id, parent)` | 挂链/下沉（防自挂防环） |
| | `promote(id)` | 上浮到祖父/根 |
| | `chain(id, depth)` | 因果链深挖 |
| | `tree({from, depth, mode})` | render / outline / json 三态 |
| 运维 | `status()` / `compact()` / `sync()` / `syncStatus()` | 状态/压实/git 同步（白名单+sha 核验）；status 含锁后端与代次 |
| 并发 | `snapshot()` | 同一代次的只读快照；多步读取/因果视界不跨代拼装 |
| | `querylogRecent/Stats/Export` | 检索日志（训练取材） |

### 底层模块（可独立使用）

```ts
import { Store, tokenize, bm25, cosine, semantic, rrfFuse, defaultTitle,
         VectorIndex, TreeScope, renderTree, chainView, causalLines,
         scan, resolveDataDir, embeddingMerged, configSet,
         Log, appendLine, exportLog, whitelisted, findRepo, sync, status,
         noneEmbedder, makeOpenAIEmbedder, makeHostEmbedder, bench } from '@rsrsai/memlite'
```

## 并发与多进程（0.3.0）

默认 `single-writer`：适合一台机器一个宿主。需要 DSH 多窗口、CLI 与宿主同时写同一目录时，显式开启：

```ts
const mem = new Memlite({
  dataDir: '/path/to/data',
  concurrency: {
    mode: 'multi-process',      // 多协议写者排队提交
    filesystem: 'local',        // NFS 需显式 nfs 并通过探针
    lockTimeoutMs: 10_000,
  },
})
```

或写入分层 `config.json`：

```json
{
  "concurrency": {
    "mode": "multi-process",
    "filesystem": "local",
    "lock_timeout_ms": 10000
  }
}
```

| 能力 | 保证 |
|---|---|
| 多读 | 读快照持共享锁；写者提交后下一次读取看到 new generation；读取返回某一代次完整状态 |
| 单写/多写 | 所有写走数据排他锁：锁内重载 → 校验父/版本/防环/显式 id → 追加 → fsync → 轮转 |
| 条件写 | `update/attach/forget` 的 `expectedRevision` 冲突抛 `STALE_VERSION`，不静默覆盖 |
| 压实/轮转 | 与写、读互斥；随机临时文件名，原子替换后再删归档 |
| 向量 | 向量排他锁 + `emb-meta.json` revision 校验；过期向量不写，由 `reembed` 补齐 |
| 日志 | `memory.querylog.jsonl` 追加持独立写锁，失败不回滚已提交记忆 |

- 原生锁来自可选 peer 依赖 `fs-ext`（Unix `flock`；Windows 语义待验收；需 `pnpm add fs-ext` 显式安装）。未安装时 `single-writer` 降级为进程内锁，`status().concurrency.lock_backend` 会显示 `in-process`；`multi-process` 直接报 `LOCK_UNSUPPORTED`。
- 锁文件：`.memlite-data.lock` / `.memlite-vector.lock` / `.memlite-log.lock`；不参与 git 同步。
- 网络文件系统：检测到 NFS/SMB 等且未配置 `filesystem: 'nfs'` 时拒绝共享写入；`nfs` 模式先跑隔离探针。**NFS 尚未完成真实双客户端验收，发布说明不宣称支持任意 NAS。**
- 与 Rust 版同库混写：Rust 端尚未同步锁协议；升级前不要让两端同时写。跨设备仍用 `memlite sync`。
- 详细设计与边界见 [并发方案](../../docs/concurrency-proposal.md)、[实施计划](../../docs/concurrency-plan.md)、[进度](../../docs/concurrency-progress.md)。

## 嵌入档（可选）

| 用法 | 适合 | 配置 |
|---|---|---|
| 纯词面（默认） | 大多数场景 | 无需配置 |
| 复用宿主 | 宿主已配好模型 | `embedding.provider: 'host'` + `deps.hostEmbedder` |
| 独立嵌入服务 | 想用专门账号 | `embedding.provider: 'openai-compatible'` + `apiBase` + 宿主凭据注入 |

**密钥永不入本包**：`openai-compatible` 档的 apiKey 经 `credentialRef` 由宿主从 write-only credentials 取出后经 `deps.credentialResolver` 注入。嵌入失败自动回退 BM25，永不阻塞 recall；remember 主路径只落 JSONL，嵌入异步执行。

## 与 Rust 版互通

- `memory.jsonl`（append-only + LWW + 16MB 轮转）、`emb.f32`+`emb-ids.txt`、`memory.querylog.jsonl`、分层 `config.json` 完全互通
- 检索常量锁定：BM25 k1=1.2 / b=0.75 / title×3、CJK 词界 U+4E00–U+9FFF、RRF k=60、防环 64 层、querylog 尾窗 50k——改动即破坏互通
- 互通测试：`MEMLITE_RS_BIN=/path/to/memlite pnpm test`（Rust 写→JS 读、JS 写→Rust recall、排序一致性）

## 开发

```bash
pnpm install
pnpm -C packages/core test        # vitest
pnpm -C packages/core typecheck   # tsc --noEmit
pnpm -C packages/core build       # tsup → dist（ESM+CJS+d.ts）
```

原生多进程测试需要可选 peer `fs-ext`（有编译工具链时）：

```bash
pnpm add -w -D fs-ext@^2.1.1      # 仅本地开发，勿提交；CI 测试任务会自行安装
pnpm -C packages/core test
```

仓库根 `.npmrc` 设了 `auto-install-peers=false`，避免开发安装时自动拉取可选 peer；没有原生锁时，
依赖它的测试（真实多进程、隔离探针）会自动 skip，其余测试照常通过。

## 协议

MIT。用户的 `memory.jsonl` 是私有数据，不入 git 白名单之外的任何通道；向量文件本机可重算，不入 git。

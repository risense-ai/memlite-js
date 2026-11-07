# memlite-js 方案

> **状态**：已批准
> **仓库**：`risense/memlite-js`
> **核心包**：`@rsrsai/memlite`
> **版本起点**：0.1.0
> **批准日期**：2026-11-07

---

## 一、定位与目标

把 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust 单文件二进制）的核心记忆机制**用 TypeScript 重写为 npm 包**，作为 DSH 插件及未来其他宿主（Kimi / ZCode / Codex 等）的**共享内核**。

### 1.1 三个目标

1. **可嵌入**：作为 npm 库被宿主插件直接 `import`，不依赖子进程，库常驻内存（召回延迟从 Rust CLI 的 50ms 降到 1ms 级）
2. **可互通**：与 Rust memlite 读写同一份数据库——`memory.jsonl` / `emb.f32` / `config.json` 三契约保留
3. **可渐进**：默认零依赖零外网（纯 BM25），嵌入档由用户显式开启

### 1.2 非目标

- 不重写 Web 管理台（Rust 版已有；JS 版跟随宿主前端栈）
- 不取代 Rust CLI（两版共存，数据互通）
- 不引入重型依赖（主包永远零 native binding）

---

## 二、技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript 5+ | 类型即文档；DSH 插件主用 TS |
| 运行时 | Node ≥ 18 | DSH 插件运行环境；`fetch`/`AbortSignal.timeout` 原生 |
| 构建 | tsup | 单文件 ESM + CJS 双产物 + d.ts |
| 包管理 | pnpm | risense 仓统一约定 |
| 测试 | vitest | TS 生态契合；快照友好 |
| 包名 | `@rsrsai/memlite` | 沿用 rsrs 命名惯例（参考 `@rsrsai/cli`） |
| 仓库 | `risense/memlite-js` | risense 组织下，与 `respire-memlite` 平行 |
| CI | GitHub Actions | 与 risense 其他仓一致 |

---

## 三、仓库结构

```
memlite-js/
├── packages/
│   └── core/                     # @rsrsai/memlite —— 核心包
│       ├── src/
│       │   ├── index.ts          # 公共出口
│       │   ├── store.ts          # append-only JSONL + HashMap + LWW + 16MB 轮转
│       │   ├── tokenize.ts       # 中英混合分词（CJK 单字+bigram）
│       │   ├── bm25.ts           # BM25 (k1=1.2, b=0.75, title×3)
│       │   ├── cosine.ts         # 余弦
│       │   ├── rrf.ts            # RRF 融合 (k=60)
│       │   ├── vectors.ts        # emb.f32 + emb-ids.txt 侧车
│       │   ├── tree.ts           # 因果树（parent_id / trivial 出树 / 防环 / 64 层封顶）
│       │   ├── sensitive.ts      # 写前敏感扫描（密码/密钥/身份证/银行卡/手机号/JWT/PEM）
│       │   ├── sync.ts           # git 白名单同步 + 双通道 sha 核验
│       │   ├── config.ts         # 三层配置合并 + data_dir 解析
│       │   ├── querylog.ts       # 检索日志 + recall_count 聚合
│       │   ├── recall.ts         # recall 主流程（含项目级→用户级回退）
│       │   └── embedding/
│       │       ├── provider.ts   # Embedder 抽象接口
│       │       ├── none.ts       # 默认：空 provider
│       │       ├── host.ts       # 复用宿主 provider（接口预留，由宿主插件注入）
│       │       └── openai.ts     # OpenAI 兼容 /embeddings
│       ├── tests/
│       ├── package.json          # name: @rsrsai/memlite
│       ├── tsconfig.json
│       ├── tsup.config.ts
│       └── README.md
├── docs/
│   ├── proposal.md               # 本文件
│   ├── plan.md                   # 里程碑与任务拆解
│   ├── embedding.md              # 嵌入档详细设计
│   └── compat.md                 # 与 Rust memlite 的互通契约
├── pnpm-workspace.yaml
├── package.json                  # 根 package（private）
├── .gitignore
└── README.md                     # 仓级入口
```

**DSH 插件**放在独立仓库 `risense/dsh-memlite`（未来建），依赖 `@rsrsai/memlite`。

---

## 四、核心契约（与 Rust memlite 完全互通）

### 4.1 `memory.jsonl` 行格式

```json
{"op":"put","id":"<12-hex>","ts":1792078629.79,"title":"...","content":"...","tags":[],"project":"","parent_id":"","importance":"important","kind":"Context"}
```

- `op ∈ {put, del}`
- `parent_id`、`importance`、`kind` 通过 serde flatten 进入 Rust 的 `extra`；JS 侧用 `Record<string, unknown>` 平铺接收
- **末写胜出**（LWW）；del 立墓碑
- 16 MB 分块轮转：活跃文件超阈值即 `rename` 成 `memory-{seq:04}.jsonl`

### 4.2 目录布局

```
data_dir/
├── memory.jsonl              # 活跃
├── memory-0001.jsonl         # 归档
├── memory.querylog.jsonl     # 检索日志
├── meta.json
├── emb.f32                   # 向量 packed f32 LE
├── emb-ids.txt               # 向量 id 顺序对齐
└── .gitignore
```

### 4.3 配置合并

```
env (MEMLITE_*) > 项目级 config.json > 用户级 ~/.memlite/config.json
```

`data_dir` 解析顺序：CLI flag > MEMLITE_DATA > 工作区 `.memlite/` 或 `memlite-data/` > 用户级 > 默认 `~/memlite-data`。

### 4.4 检索算法参数（不可改动，改动即破坏互通）

| 参数 | 值 | 出处 |
|---|---|---|
| BM25 k1 | 1.2 | [search.rs:99](https://github.com/risense-ai/respire-memlite/blob/main/rust/src/search.rs) |
| BM25 b | 0.75 | 同上 |
| title 权重 | ×3 | `docTokens` 重复三次 |
| CJK 词界 | U+4E00–U+9FFF | 勿扩全 CJK（标点会改 doc 长度漂移 0.7%） |
| RRF k | 60 | 常量 |
| 因果链防环封顶 | 64 层 | `ancestorChain` |

---

## 五、嵌入档设计

### 5.1 三档 Provider

```ts
type EmbeddingProvider = 'none' | 'host' | 'openai-compatible'

interface Embedder {
  embed(text: string, opts?: { timeoutMs?: number }): Promise<Float32Array>
  readonly dim?: number
}
```

| 档 | 实现 | 默认 |
|---|---|---|
| `none` | 返回空，调用方直接走 BM25 | ✅ |
| `host` | 由宿主插件注入 `Embedder` 实例 | — |
| `openai-compatible` | 核心包内置 fetch 实现 | — |

### 5.2 核心包配置接口

```ts
interface MemliteConfig {
  dataDir: string
  recallLimit: number              // 默认 10
  sync?: { auto: boolean; remote?: string }
  embedding?: {
    provider: EmbeddingProvider
    apiBase?: string               // openai-compatible 必填
    model?: string                 // 默认 'BAAI/bge-m3'
    credentialRef?: string         // 宿主 credentials 引用名
    timeoutMs?: number             // 默认 30000
  }
  sensitiveGate: boolean           // 默认 true
}
```

**密钥永不入本包配置**——`openai-compatible` 档的 apiKey 通过 `credentialRef` 由宿主（如 DSH）从 write-only credentials 取出后注入到 Embedder 工厂。

### 5.3 嵌入失败语义

- `recall`：嵌入失败 → 自动回退 BM25，**永不阻塞**
- `remember`：主路径只落 JSONL（不依赖嵌入），嵌入**异步**执行；失败仅记日志，记忆本体已入库可被 BM25 命中

---

## 六、DSH 插件接入契约（预览，不在本仓）

未来 `risense/dsh-memlite` 的形态：

```ts
import { Context, Schema } from '@deepseek-ai/cordis'
import { Memlite } from '@rsrsai/memlite'

export const name = 'memlite'

export const Config = Schema.object({
  dataDir: Schema.string().default('~/.memlite'),
  recallLimit: Schema.number().default(10),
  sync: Schema.object({...}).default({}),
  embedding: Schema.object({
    provider: Schema.union(['none','host','openai-compatible']).default('none'),
    ...
  }).default({}),
  sensitiveGate: Schema.boolean().default(true),
})

export function apply(ctx: Context, config: Config) {
  const mem = new Memlite(config, {
    hostEmbedder: config.embedding.provider === 'host'
      ? makeHostEmbedder(ctx)
      : undefined,
    credentialResolver: (ref) => ctx.credentials.get(ref),
  })
  ctx.on('ready', () => mem.open())
  ctx.on('dispose', () => mem.close())
  // 注册命令：recall/remember/show/tree/sync/...
}
```

DSH 的配置 UI 由框架自动渲染 schema——**插件侧零前端代码**。

---

## 七、验证策略

### 7.1 与 Rust 版的互通测试（关键）

`tests/compat/`：

1. **读 Rust 写的库**：用 Rust memlite 写入若干条记忆 + 向量，JS 读出并命中
2. **写 JS 写的库**：用 JS 写入，Rust `memlite recall` 能命中
3. **RRF 一致性**：同一查询两版返回顺序一致（允许小数误差）

### 7.2 bench 对齐

移植 memlite 的 20 条记忆 + 20 改写型查询 bench 到 JS，跑分对比：

| 档 | memlite Rust | memlite-js | 容差 |
|---|---|---|---|
| BM25 hit@1 | 85% | 85% | 必须一致 |
| BM25 hit@3 | 85% | 85% | 必须一致 |
| 语义+RRF hit@3 | 90% | ≥88% | 允许小差 |

---

## 八、风险与开放问题

| 项 | 状态 | 处置 |
|---|---|---|
| npm scope `@rsrsai` 可用性 | 已确认 | 团队在用（`@rsrsai/cli`） |
| DSH 插件 credentials API | 待核实 | M7 启动前先翻 dsh 文档 |
| 库规模爆炸（>10 万条） | 远期 | 当前全量扫策略足够；真到那个量级再考虑倒排 |
| 与 Rust memlite 字段演进冲突 | 持续 | 每次 Rust 加字段同步加到 JS Record 类型；CI 跑互通测试 |

---

## 九、下一步

进入 [plan.md](./plan.md) 的 M1 阶段。

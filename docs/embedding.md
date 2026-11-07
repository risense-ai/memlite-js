# 嵌入档详设

> 与 [proposal.md §5](./proposal.md) 配套，给出实现级细节。

---

## 一、三档 Provider

```ts
type EmbeddingProvider = 'none' | 'host' | 'openai-compatible'
```

| 档 | 行为 | 用户成本 |
|---|---|---|
| `none`（默认） | 纯 BM25 | 零 |
| `host` | 复用宿主 provider | 在宿主已配好 key |
| `openai-compatible` | 独立嵌入服务 | 单独配一套嵌入账号 |

---

## 二、Embedder 抽象接口

```ts
interface Embedder {
  embed(text: string, opts?: EmbedOptions): Promise<Float32Array>
  readonly dim?: number
}

interface EmbedOptions {
  timeoutMs?: number
}

type EmbedderFactory = (
  cfg: ResolvedEmbeddingConfig,
  deps: EmbedderDeps,
) => Promise<Embedder>

interface EmbedderDeps {
  credentialResolver?: (ref: string) => Promise<string | undefined>
  hostEmbedder?: Embedder    // host 档时由宿主注入
  logger?: { warn(msg: string): void }
}
```

---

## 三、各档实现

### 3.1 `none`

```ts
export const noneEmbedder: Embedder = {
  async embed() { return new Float32Array(0) },
  dim: 0,
}
```

调用方检测到 `dim === 0` 或返回空向量时直接走 BM25，**不进 RRF**。

### 3.2 `openai-compatible`

```ts
export async function makeOpenAIEmbedder(
  cfg: { apiBase: string; model: string; credentialRef: string; timeoutMs: number },
  deps: EmbedderDeps,
): Promise<Embedder> {
  const apiKey = await deps.credentialResolver?.(cfg.credentialRef)
  if (!apiKey) {
    throw new Error(`credentials 中未找到 ${cfg.credentialRef}`)
  }
  return {
    async embed(text, opts) {
      const r = await fetch(`${cfg.apiBase.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: cfg.model, input: text }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? cfg.timeoutMs),
      })
      if (!r.ok) throw new Error(`/embeddings ${r.status}: ${await r.text()}`)
      const j = await r.json()
      const arr = j?.data?.[0]?.embedding
      if (!Array.isArray(arr)) throw new Error('响应形状不符')
      return Float32Array.from(arr)
    },
  }
}
```

### 3.3 `host`

核心包**不实现**，由宿主插件注入：

```ts
// DSH 插件侧（risense/dsh-memlite）
function makeHostEmbedder(ctx: Context): Embedder {
  return {
    async embed(text, opts) {
      const provider = await ctx.providers.current()
      if (!provider.supportsEmbeddings) {
        throw new Error('当前宿主 provider 不支持 /embeddings')
      }
      return ctx.providers.embed(provider.id, text, opts)
    },
  }
}
```

---

## 四、recall 主流程（含回退）

```ts
async function recall(query: string, opts: RecallOpts): Promise<Hit[]> {
  // 1. BM25 永远算——既是融合臂也是兜底
  const pool = Math.max(opts.limit * 10, 50)
  const bm = bm25(query, { limit: pool, project: opts.project })

  if (opts.bm25Only) return bm.slice(0, opts.limit)

  // 2. 嵌入档
  const embedder = await resolveEmbedder()
  if (embedder.dim === 0) return bm.slice(0, opts.limit)  // none 档

  try {
    const qv = await embedder.embed(query, { timeoutMs: cfg.embedding.timeoutMs })
    if (qv.length === 0) return bm.slice(0, opts.limit)

    const sem = semantic(qv, { limit: pool, project: opts.project })
    if (sem.length === 0) return bm.slice(0, opts.limit)

    return rrfFuse([sem, bm], opts.limit)
  } catch (e) {
    logger.warn(`嵌入失败，回退 BM25: ${e.message}`)
    return bm.slice(0, opts.limit)
  }
}
```

**关键不变量**：
- 嵌入失败**永不 throw**——回退 BM25
- `none` 档零外部调用零网络开销
- 用户切档即时生效（DSH 热重载天然保证）

---

## 五、remember 主流程（嵌入异步）

```ts
async function remember(content: string, opts: RememberOpts): Promise<string> {
  // 1. 敏感闸（始终先跑）
  if (cfg.sensitiveGate) scanOrReject(content)

  // 2. 落 JSONL（不依赖嵌入，立即可被 BM25 检索到）
  const id = await store.put(content, opts)

  // 3. 若嵌入开启，异步入向量
  if (cfg.embedding.provider !== 'none') {
    setImmediate(async () => {
      try {
        const embedder = await resolveEmbedder()
        const v = await embedder.embed(content)
        if (v.length > 0) await vectors.put(id, v)
      } catch (e) {
        logger.warn(`记忆 ${id} 嵌入失败，将被语义档跳过: ${e.message}`)
      }
    })
  }

  return id
}
```

**核心契约**：嵌入是**异步增强**，不在主路径上。remember 永远成功，嵌入失败只意味着"这条不被语义档命中"，BM25 仍可命中。

---

## 六、reembed 工具

给旧记忆批量回填向量（嵌入档开启后需要）：

```ts
async function reembed(opts: { batchSize?: number } = {}) {
  const embedder = await resolveEmbedder()
  if (embedder.dim === 0) throw new Error('嵌入档未开启')

  const all = store.all()
  let done = 0
  for (const r of all) {
    if (vectors.has(r.id)) continue
    const text = `${r.title}\n${r.content}`
    const v = await embedder.embed(text)
    if (v.length > 0) {
      await vectors.put(r.id, v)
      done++
    }
  }
  return { total: all.length, embedded: done }
}
```

---

## 七、密钥管理

### 7.1 永不入本包

`@rsrsai/memlite` 的配置接口里**没有 apiKey 字段**。密钥通过 `credentialRef`（字符串引用名）由宿主从 write-only credentials 取出后注入 Embedder 工厂。

### 7.2 与 Rust 版的兼容

- **读**：JS 仍**读取** Rust 写的 `config.json.embedding.api_key`（向后兼容）
- **写**：JS **不写** apiKey 字段——优先 credentialRef；用户坚持用配置文件时支持但不推荐

### 7.3 DSH 侧

DSH 提供 `ctx.credentials.get(ref)` 接口。用户在 DSH Models 设置页配置 provider 时密钥已入 credentials；插件用 `credentialRef: 'MEMLITE_EMBED_API_KEY'`（默认）取出即可。

---

## 八、用户文档示例

```markdown
## 嵌入档（可选）

默认纯词面 BM25，零依赖零配置。想要语义检索，三选一：

| 用法 | 适合 | 配置 |
|---|---|---|
| 纯词面（默认） | 大多数场景 | 无需配置 |
| 复用宿主 | 已在 DSH 配好 OpenAI/硅基等 | `embedding.provider: host` |
| 独立嵌入服务 | 想用专门的嵌入账号 | `embedding.provider: openai-compatible` + apiBase + 在 DSH 凭据里存 key |

切换即时生效。嵌入失败自动回退 BM25，永不阻塞。
```

---

## 九、测试要点

- [ ] none 档：embed() 返回空向量，recall 走纯 BM25
- [ ] openai 档：mock fetch 三种响应（成功/4xx/超时）
- [ ] host 档：注入 mock Embedder
- [ ] recall 嵌入失败回退 BM25 不 throw
- [ ] remember 嵌入失败仍返回 id
- [ ] reembed 跳过已有向量的记忆
- [ ] credentialRef 取不到时报错（初始化期而非运行期）

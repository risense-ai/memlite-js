/**
 * OpenAI 兼容 /embeddings 实现（embedding.md §3.2）。
 * fetch + AbortSignal.timeout；错误分类：网络 / 4xx / 5xx / 响应形状不符。
 * 关键不变量：调用方（recall/remember）把 embed 抛错当回退信号，永不阻塞主路径。
 */
import type { EmbedOptions, Embedder, EmbedderDeps, ResolvedEmbeddingConfig } from './provider'

/** 嵌入错误分类：调用方可按类记日志，不影响回退语义。 */
export class EmbedError extends Error {
  readonly kind: 'network' | 'client' | 'server' | 'shape' | 'credential' | 'timeout'
  constructor(kind: EmbedError['kind'], message: string) {
    super(message)
    this.name = 'EmbedError'
    this.kind = kind
  }
}

export async function makeOpenAIEmbedder(
  cfg: ResolvedEmbeddingConfig & { apiBase: string },
  deps: EmbedderDeps,
): Promise<Embedder> {
  const apiKey = (await deps.credentialResolver?.(cfg.credentialRef)) ?? ''
  if (!apiKey) {
    // 初始化期报错（而非运行期）——credentialRef 取不到立刻暴露
    throw new EmbedError('credential', `credentials 中未找到 ${cfg.credentialRef}`)
  }
  let dim: number | undefined
  return {
    get dim() {
      return dim
    },
    async embed(text: string, opts?: EmbedOptions): Promise<Float32Array> {
      const timeoutMs = opts?.timeoutMs ?? cfg.timeoutMs
      let r: Response
      try {
        r = await fetch(`${cfg.apiBase.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: cfg.model, input: text }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        if (e instanceof Error && e.name === 'TimeoutError') {
          throw new EmbedError('timeout', `嵌入超时（${timeoutMs}ms）`)
        }
        throw new EmbedError('network', `嵌入 API 不可达: ${String(e)}`)
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        if (r.status >= 500) {
          throw new EmbedError('server', `/embeddings ${r.status}: ${body}`)
        }
        throw new EmbedError('client', `/embeddings ${r.status}: ${body}`)
      }
      let j: unknown
      try {
        j = await r.json()
      } catch {
        throw new EmbedError('shape', '响应不是 JSON')
      }
      const arr = (j as { data?: Array<{ embedding?: unknown }> } | null)?.data?.[0]?.embedding
      if (!Array.isArray(arr)) {
        throw new EmbedError('shape', '响应形状不符')
      }
      const v = Float32Array.from(arr as number[])
      dim ??= v.length
      return v
    },
  }
}

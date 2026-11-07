/**
 * Embedder 抽象接口（embedding.md §二）。
 * 密钥永不入本包——apiKey 通过 credentialRef 由宿主从 write-only credentials
 * 取出后注入 Embedder 工厂。
 */

export type EmbeddingProvider = 'none' | 'host' | 'openai-compatible'

export interface EmbedOptions {
  timeoutMs?: number
}

export interface Embedder {
  embed(text: string, opts?: EmbedOptions): Promise<Float32Array>
  /** dim 0 = 纯词面档（none），调用方直接走 BM25 */
  readonly dim?: number
}

/** 解析后的嵌入配置（provider 已定、默认值已补） */
export interface ResolvedEmbeddingConfig {
  provider: EmbeddingProvider
  apiBase?: string
  /** 默认 'BAAI/bge-m3' */
  model: string
  /** 宿主 credentials 引用名 */
  credentialRef: string
  /** 默认 30000 */
  timeoutMs: number
}

export interface EmbedderDeps {
  credentialResolver?: (ref: string) => Promise<string | undefined>
  /** host 档时由宿主注入 */
  hostEmbedder?: Embedder
  logger?: { warn(msg: string): void }
}

export type EmbedderFactory = (
  cfg: ResolvedEmbeddingConfig,
  deps: EmbedderDeps,
) => Promise<Embedder>

/**
 * host 档：核心包不实现嵌入本身，由宿主插件注入 Embedder（embedding.md §3.3）。
 *
 * 宿主（如 DSH 插件）实现示例：
 * ```ts
 * function makeHostEmbedder(ctx: Context): Embedder {
 *   return {
 *     async embed(text, opts) {
 *       const provider = await ctx.providers.current()
 *       if (!provider.supportsEmbeddings) {
 *         throw new Error('当前宿主 provider 不支持 /embeddings')
 *       }
 *       return ctx.providers.embed(provider.id, text, opts)
 *     },
 *   }
 * }
 * ```
 * 注入方式：`new Memlite(config, { hostEmbedder: makeHostEmbedder(ctx) })`，
 * 且 config.embedding.provider === 'host'。
 */
import type { EmbedOptions, Embedder } from './provider'

export interface HostEmbedFn {
  (text: string, opts?: EmbedOptions): Promise<Float32Array>
}

/** 把宿主的单个 embed 函数包成 Embedder（宿主已有完整 Embedder 时直接注入即可） */
export function makeHostEmbedder(embedFn: HostEmbedFn, dim?: number): Embedder {
  return {
    embed: (text, opts) => embedFn(text, opts),
    ...(dim !== undefined ? { dim } : {}),
  }
}

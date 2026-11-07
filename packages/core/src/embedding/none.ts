/**
 * 默认档：空 provider，调用方检测到 dim 0 直接走 BM25，不进 RRF（embedding.md §3.1）。
 */
import type { Embedder } from './provider'

export const noneEmbedder: Embedder = {
  async embed() {
    return new Float32Array(0)
  },
  dim: 0,
}

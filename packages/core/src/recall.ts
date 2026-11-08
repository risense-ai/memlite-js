/**
 * recall 主流程（含项目级→用户级回退）——Rust main.rs recall_search 的移植。
 * BM25 永远算——既是融合臂也是兜底；语义可用且有命中才进 RRF；
 * 嵌入失败永不 throw——回退 BM25。
 */
import { bm25, type Scored } from './bm25'
import { semantic } from './cosine'
import { rrfFuse } from './rrf'
import { Store, recordRevision, type MemRecord } from './store'
import { VectorIndex, type VectorSnapshot } from './vectors'
import type { Embedder } from './embedding/provider'

export type RecallBackend = 'bm25' | 'rrf' | 'semantic'

export interface SearchOnceOpts {
  limit: number
  project: string
  /** 强制词面档 */
  bm25Only: boolean
}

export interface SearchOnceResult {
  backend: RecallBackend
  hits: Array<Scored<MemRecord>>
}

/** 单库检索一次：BM25 必算 → 嵌入 → RRF。vectors 为 undefined 时跳过语义臂。
 * 嵌入失败回退 BM25（logger.warn 提示），永不阻塞。 */
export async function searchOnce(
  records: MemRecord[],
  vectors: VectorIndex | undefined,
  embedder: Embedder | undefined,
  query: string,
  opts: SearchOnceOpts,
  logger?: { warn(msg: string): void },
): Promise<SearchOnceResult> {
  const pool = Math.max(opts.limit * 10, 50)
  const bm = bm25(records, query, pool, opts.project)
  if (opts.bm25Only) {
    return { backend: 'bm25', hits: bm.slice(0, opts.limit) }
  }
  if (embedder !== undefined && (embedder.dim ?? 1) !== 0 && vectors !== undefined) {
    let vecSnapshot: VectorSnapshot | undefined
    try {
      vecSnapshot = vectors.snapshot('vector.search')
    } catch (e) {
      logger?.warn(`向量不可用，回退 BM25: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (vecSnapshot !== undefined) {
      try {
        const qv = await embedder.embed(query)
        if (qv.length > 0) {
          const revById = new Map(records.map((r) => [r.id, recordRevision(r)]))
          const getVector = (id: string): number[] | undefined => {
            const recorded = vecSnapshot!.revisionOf(id)
            // 新格式带 revision：与当前记忆版本不一致的向量不参与语义匹配（由 reembed 补齐）。
            if (recorded !== undefined) {
              const current = revById.get(id)
              if (current === undefined || current !== recorded) return undefined
            }
            return vecSnapshot!.get(id)
          }
          const sem = semantic(records, qv, pool, opts.project, getVector)
          if (sem.length > 0) {
            return { backend: 'rrf', hits: rrfFuse([sem, bm], opts.limit) }
          }
        }
      } catch (e) {
        logger?.warn(`嵌入失败，回退 BM25: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return { backend: 'bm25', hits: bm.slice(0, opts.limit) }
}

export interface RecallSearchOpts extends SearchOnceOpts {
  embedder?: Embedder
  logger?: { warn(msg: string): void }
}

/** 目录级检索：每次开新 Store（与 Rust 短进程语义一致；常驻场景用 Memlite.recall）。 */
export async function recallSearch(
  dir: string,
  query: string,
  opts: RecallSearchOpts,
): Promise<SearchOnceResult> {
  const s = new Store(dir)
  let vectors: VectorIndex | undefined
  if (opts.embedder !== undefined && !opts.bm25Only) {
    try {
      vectors = new VectorIndex(dir)
    } catch (e) {
      opts.logger?.warn(`向量侧车不可用，回退 BM25: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return searchOnce(s.all(), vectors, opts.embedder, query, opts, opts.logger)
}

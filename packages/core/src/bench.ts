/**
 * 检索命中率评测：20 条真实形态记忆 × 20 改写型查询，报 hit@1 / hit@3（移植 Rust bench.rs）。
 * 临时数据目录端到端跑产品检索链路（词面 BM25 / 语义＋词面兜底）。
 * 查询按用户自然提问写，不为刷分贴原词，如实反映检索在小库上的能力边界。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store'
import { VectorIndex } from './vectors'
import { recallSearch } from './recall'
import { CORPUS, type CorpusItem } from './bench-corpus'
import type { Embedder } from './embedding/provider'

export { CORPUS }
export type { CorpusItem }

export interface BenchResult {
  mode: string
  records: number
  queries: number
  bm25_fallback: number
  hit1: string
  hit3: string
  hit1_pct: number
  hit3_pct: number
  misses: string[]
}

/** 跑 bench：dir 缺省用临时目录并自清理；embedder 缺省纯词面档。 */
export async function bench(opts: {
  dir?: string
  embedder?: Embedder
  logger?: { warn(msg: string): void }
} = {}): Promise<BenchResult> {
  const cleanup = !opts.dir
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'memlite-js-bench-'))
  try {
    const semantic = opts.embedder !== undefined
    const s = new Store(dir)
    const vidx = semantic ? new VectorIndex(dir) : undefined
    const ids: string[] = []
    for (const [title, content] of CORPUS) {
      const rid = s.put(content, title, [], '')
      if (semantic && vidx) {
        const v = await opts.embedder!.embed(`${title}\n${content}`)
        vidx.put(rid, v)
      }
      ids.push(rid)
    }
    const n = CORPUS.length
    let hits1 = 0
    let hits3 = 0
    const misses: string[] = []
    let bm25Fallback = 0
    for (const [i, item] of CORPUS.entries()) {
      // 复用产品检索路径：配 embedder 为 rrf 融合，语义不可用回落 bm25（如实计数）
      const { backend, hits } = await recallSearch(dir, item[2], {
        limit: 3,
        project: '',
        bm25Only: !semantic,
        embedder: opts.embedder,
        logger: opts.logger,
      })
      if (backend === 'bm25' && semantic) bm25Fallback++
      const top = hits.map((h) => h.record.id)
      if (top[0] === ids[i]) hits1++
      if (top.includes(ids[i])) hits3++
      else misses.push(item[2])
    }
    return {
      mode: semantic ? 'semantic' : 'bm25',
      records: n,
      queries: n,
      bm25_fallback: bm25Fallback,
      hit1: `${hits1}/${n}`,
      hit3: `${hits3}/${n}`,
      hit1_pct: Math.round((hits1 / n) * 100),
      hit3_pct: Math.round((hits3 / n) * 100),
      misses,
    }
  } finally {
    if (cleanup) rmSync(dir, { recursive: true, force: true })
  }
}

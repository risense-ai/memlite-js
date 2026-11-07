import * as fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { bench } from '../src/bench'
import { CORPUS } from '../src/bench-corpus'
import type { Embedder } from '../src/embedding/provider'

describe('bench（纯 BM25 档）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('20 条 × 20 查询跑通，hit@3 达标（≥85%）', async () => {
    expect(CORPUS.length).toBe(20)
    const r = await bench()
    expect(r.mode).toBe('bm25')
    expect(r.records).toBe(20)
    expect(r.queries).toBe(20)
    // proposal §7.2：BM25 hit@3 必须 85%（与 Rust 一致）
    expect(r.hit3_pct).toBeGreaterThanOrEqual(85)
    expect(r.misses.length).toBe(20 - Number(r.hit3.split('/')[0]))
  })
})

describe('bench（注入 mock 语义档）', () => {
  it('rrf 路径端到端可跑', async () => {
    const emb: Embedder = {
      dim: 2,
      async embed(text: string) {
        return Float32Array.from([text.length % 2, 1])
      },
    }
    const r = await bench({ embedder: emb })
    expect(r.mode).toBe('semantic')
    expect(r.queries).toBe(20)
  })
})

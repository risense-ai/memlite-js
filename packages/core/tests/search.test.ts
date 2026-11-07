import { describe, expect, it } from 'vitest'
import { bm25, defaultTitle } from '../src/bm25'
import { cosine, semantic } from '../src/cosine'
import { rrfFuse } from '../src/rrf'
import { tokenize } from '../src/tokenize'
import type { MemRecord } from '../src/store'

function rec(id: string, ts: number, title: string, content: string): MemRecord {
  return { op: 'put', id, ts, title, content, tags: [], project: '', extra: {} }
}

describe('tokenize_mixed', () => {
  it('ASCII 整词小写 + CJK 单字', () => {
    const t = tokenize('memlite 是 Python 写的')
    expect(t).toContain('memlite')
    expect(t).toContain('python')
    expect(t).toContain('写')
  })
})

describe('tokenize_cjk_bigram_plus_unigram', () => {
  it('CJK 段单字 + bigram', () => {
    const t = tokenize('记忆系统')
    expect(t).toContain('记忆')
    expect(t).toContain('忆系')
    expect(t).toContain('系统')
    expect(t).toContain('记') // 单字保查询可中
  })
})

describe('bm25_finds_and_ranks', () => {
  it('命中且相关在前', () => {
    const r1 = rec('1', 1.0, 'rust 编译', 'cargo build 慢用 sccache')
    const r2 = rec('2', 2.0, '菜谱', '番茄炒蛋的做法')
    const r3 = rec('3', 3.0, '', 'rust 编译缓存 sccache 配置')
    const all = [r1, r2, r3]
    const hits = bm25(all, 'rust 编译', 3, '')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].record.id === '1' || hits[0].record.id === '3').toBe(true)
  })
})

describe('bm25_title_weight', () => {
  it('title×3 权重压过正文单次', () => {
    const r1 = rec('1', 1.0, 'kubernetes 部署', '无关内容')
    const r2 = rec('2', 2.0, '别的', '提到一次 kubernetes')
    const hits = bm25([r1, r2], 'kubernetes', 3, '')
    expect(hits[0].record.id).toBe('1')
  })
})

describe('bm25_project_filter', () => {
  it('project 过滤', () => {
    const r1 = rec('1', 1.0, '', '金秤 策略')
    r1.project = 'goldscale'
    const r2 = rec('2', 2.0, '', '金秤 记忆')
    const hits = bm25([r1, r2], '金秤', 3, 'goldscale')
    expect(hits.length).toBe(1)
    expect(hits[0].record.id).toBe('1')
  })
})

describe('cosine_range_and_mismatch', () => {
  it('同向 1、长度不符与空向量 0', () => {
    expect(cosine([1.0, 0.0], [1.0, 0.0])).toBe(1.0)
    expect(cosine([1.0], [1.0, 2.0])).toBe(0.0)
    expect(cosine([], [1.0])).toBe(0.0)
  })
})

describe('rrf_fuse_dedup_and_both_lists_win', () => {
  it('同 id 合并、两路都中者居首、limit 截断', () => {
    const a = rec('a', 1.0, '甲', '')
    const b = rec('b', 2.0, '乙', '')
    const c = rec('c', 3.0, '丙', '')
    // a 两路命中（1/61+1/62）居首，b 词面第 1（1/61）胜 c 语义第 2（1/62）
    const sem = [
      { score: 0.9, record: a },
      { score: 0.8, record: c },
    ]
    const kw = [
      { score: 5.0, record: b },
      { score: 4.0, record: a },
    ]
    const fused = rrfFuse([sem, kw], 10)
    expect(fused.length).toBe(3) // 同 id 合并不重复
    expect(fused[0].record.id).toBe('a')
    expect(fused[0].score).toBeGreaterThan(fused[1].score)
    expect(fused[1].score).toBeGreaterThan(fused[2].score)
    // b(1/61) 应胜 c(1/62)
    expect(fused[1].record.id).toBe('b')
    expect(fused[2].record.id).toBe('c')
    // limit 截断生效
    expect(
      rrfFuse(
        [
          [
            { score: 0.9, record: a },
            { score: 0.8, record: b },
            { score: 0.7, record: c },
          ],
        ],
        2,
      ).length,
    ).toBe(2)
  })
})

describe('default_title_first_sentence', () => {
  it('首句截断与 40 字上限', () => {
    expect(defaultTitle('nginx 反代 504 超时。调大 timeout 解决。')).toBe('nginx 反代 504 超时')
    const long = '很长的正文'.repeat(30)
    expect([...defaultTitle(long)].length).toBeLessThanOrEqual(40)
  })
})

describe('semantic', () => {
  it('只排有向量记录、project 过滤、零分不进', () => {
    const a = rec('a', 1.0, '', 'x')
    a.project = 'p'
    const b = rec('b', 2.0, '', 'y')
    const hits = semantic([a, b], [1, 0], 10, 'p', (id) => (id === 'a' ? [1, 0] : undefined))
    expect(hits.length).toBe(1)
    expect(hits[0].record.id).toBe('a')
    // 查询空向量 → 空
    expect(semantic([a], [], 10, '', () => [1, 0]).length).toBe(0)
  })
})

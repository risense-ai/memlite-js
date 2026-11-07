/** 检索文本：title×3 权重 + content + tags（与 Rust doc_tokens 同序）。 */
import type { MemRecord } from './store'
import { tokenize } from './tokenize'

export function docTokens(r: MemRecord): string[] {
  const toks = tokenize(r.content)
  toks.push(...tokenize(r.tags.join(' ')))
  for (let i = 0; i < 3; i++) toks.push(...tokenize(r.title))
  return toks
}

export interface Scored<R> {
  score: number
  record: R
}

/** BM25 打分（k1=1.2, b=0.75），降序返回；同分 ts 新者先。project 非空时过滤。 */
export function bm25<R extends MemRecord>(
  records: R[],
  query: string,
  limit: number,
  project: string,
): Array<Scored<R>> {
  const q = tokenize(query)
  if (q.length === 0) return []
  const qtf = new Map<string, number>()
  for (const t of q) qtf.set(t, (qtf.get(t) ?? 0) + 1)
  const pool = project === '' ? records : records.filter((r) => r.project === project)
  if (pool.length === 0) return []
  const docs = pool.map((r) => {
    const toks = docTokens(r)
    const tf = new Map<string, number>()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { tf, dl: toks.length }
  })
  const df = new Map<string, number>()
  for (const { tf } of docs) {
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const n = docs.length
  const avgDl = docs.reduce((s, d) => s + d.dl, 0) / n
  const k1 = 1.2
  const b = 0.75
  const scored: Array<Scored<R>> = []
  for (let i = 0; i < docs.length; i++) {
    const { tf, dl } = docs[i]
    let s = 0
    for (const [term, qf] of qtf) {
      const tfc = tf.get(term)
      if (tfc === undefined) continue
      const d = df.get(term) ?? 1
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5))
      s += qf * idf * ((tfc * (k1 + 1)) / (tfc + k1 * (1 - b + (b * dl) / Math.max(avgDl, 1e-9))))
    }
    if (s > 0) scored.push({ score: s, record: pool[i] })
  }
  scored.sort((x, y) => y.score - x.score || y.record.ts - x.record.ts)
  return scored.slice(0, limit)
}

/** 标题铁律：缺省截正文首句 ≤40 字。 */
export function defaultTitle(content: string): string {
  const head = content.split('\n')[0] ?? ''
  let cut = head.length
  for (const sep of ['。', '！', '？', '. ', '! ', '? ']) {
    const p = head.indexOf(sep)
    if (p >= 0 && p < cut) cut = p
  }
  return [...head.slice(0, cut)].slice(0, 40).join('')
}

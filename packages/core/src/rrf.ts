/** RRF 融合（k=60）：各候选列表按位次累加 1/(k+位次+1)，只看位次不吃量纲——
 * 语义余弦与 BM25 分数可直接合。同 id 合并，同分 ts 新者先（与单档排序同口径）。 */
import type { Scored } from './bm25'

export function rrfFuse<R extends { id: string; ts: number }>(
  lists: Array<Array<Scored<R>>>,
  limit: number,
): Array<Scored<R>> {
  const K = 60
  const fused = new Map<string, { score: number; record: R }>()
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]
      const slot = fused.get(item.record.id)
      if (slot) {
        slot.score += 1 / (K + rank + 1)
      } else {
        fused.set(item.record.id, { score: 1 / (K + rank + 1), record: item.record })
      }
    }
  }
  const out = [...fused.values()]
  out.sort((a, b) => b.score - a.score || b.record.ts - a.record.ts)
  return out.slice(0, limit)
}

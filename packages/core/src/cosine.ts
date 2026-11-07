/** 余弦：零向量/长度不符返回 0（与 Rust cosine 同语义）。 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  na = Math.sqrt(na)
  nb = Math.sqrt(nb)
  if (na === 0 || nb === 0) return 0
  return dot / (na * nb)
}

/** 余弦语义：vecGetter 从侧车取向量，只排有向量的记录（与 Rust semantic 同语义）。 */
export function semantic<R extends { id: string; ts: number; project: string }>(
  records: R[],
  queryEmb: ArrayLike<number>,
  limit: number,
  project: string,
  vecGetter: (id: string) => number[] | Float32Array | undefined,
): Array<{ score: number; record: R }> {
  if (queryEmb.length === 0) return []
  const scored: Array<{ score: number; record: R }> = []
  for (const r of records) {
    if (project !== '' && r.project !== project) continue
    const v = vecGetter(r.id)
    if (v === undefined) continue
    const s = cosine(queryEmb, v)
    if (s > 0) scored.push({ score: s, record: r })
  }
  scored.sort((a, b) => b.score - a.score || b.record.ts - a.record.ts)
  return scored.slice(0, limit)
}

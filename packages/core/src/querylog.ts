/**
 * 检索日志（query_log）：一次 recall/检索落一行，外加按条聚合的召回次数。
 * 训练与复盘取材用。文件：data_dir/memory.querylog.jsonl（追加式；名字过白名单
 * memory*.jsonl 随 sync 走，且不撞 Store 的 memory-<n>.jsonl 归档命名）。
 * 次数不另设可变计数文件——全量聚合自日志，进程内常驻。
 * 与 Rust memlite querylog.rs 行格式互通（compat.md §六）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const LOG_FILE = 'memory.querylog.jsonl'
/** 载入内存保留的最近条数（recent/stats 展示窗口；counts 按全量行聚合） */
const KEEP = 50_000

export interface Hit {
  id: string
  /** 原始分（未四舍五入） */
  score: number
  title: string
}

export interface Entry {
  ts: number
  query: string
  /** semantic | bm25 | rrf */
  backend: string
  limit: number
  /** 空＝本库命中；"user"＝项目级无命中回退用户级 */
  fallback: string
  /** cli | web | dsh | 其他宿主名 */
  source: string
  /** 端到端耗时（毫秒，含回退那次） */
  ms: number
  hits: Hit[]
}

function entryJson(e: Entry): string {
  return JSON.stringify({
    ts: e.ts,
    query: e.query,
    backend: e.backend,
    limit: e.limit,
    fallback: e.fallback,
    source: e.source,
    ms: e.ms,
    hits: e.hits.map((h) => ({ id: h.id, score: h.score, title: h.title })),
  })
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

function parseEntry(line: string): Entry | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  if (typeof o.ts !== 'number' || typeof o.query !== 'string' || typeof o.backend !== 'string') return null
  const rawHits = Array.isArray(o.hits) ? o.hits : []
  const hits: Hit[] = []
  for (const h of rawHits) {
    if (h && typeof h === 'object') {
      const hh = h as Record<string, unknown>
      if (typeof hh['id'] === 'string' && typeof hh['score'] === 'number') {
        hits.push({ id: hh['id'], score: hh['score'], title: typeof hh['title'] === 'string' ? hh['title'] : '' })
      }
    }
  }
  return {
    ts: o.ts,
    query: o.query,
    backend: o.backend,
    limit: typeof o.limit === 'number' ? o.limit : 0,
    fallback: typeof o.fallback === 'string' ? o.fallback : '',
    source: typeof o.source === 'string' ? o.source : '',
    ms: typeof o.ms === 'number' ? o.ms : 0,
    hits,
  }
}

function logPath(dataDir: string): string {
  return path.join(dataDir, LOG_FILE)
}

/** 日志在进程内的常驻形态：尾窗条目 + 全量命中次数 */
export class Log {
  private entries: Entry[] = []
  private counts = new Map<string, number>()
  private total = 0
  private badLines = 0

  /** 载入：全文件扫一遍聚 counts（total/bad_lines 全量），entries 只留末 KEEP 条 */
  constructor(dataDir: string) {
    let text: string
    try {
      text = fs.readFileSync(logPath(dataDir), 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    const start = Math.max(0, lines.length - KEEP)
    for (const [i, line] of lines.entries()) {
      const e = parseEntry(line)
      if (e === null) {
        this.badLines++
        continue
      }
      for (const h of e.hits) this.counts.set(h.id, (this.counts.get(h.id) ?? 0) + 1)
      if (i >= start) this.entries.push(e)
      this.total++
    }
  }

  /** 落盘一行并就地更新内存视图（memory 持有时） */
  append(dataDir: string, e: Entry): void {
    appendLine(dataDir, e)
    for (const h of e.hits) this.counts.set(h.id, (this.counts.get(h.id) ?? 0) + 1)
    this.total++
    this.entries.push(e)
    if (this.entries.length > KEEP) {
      this.entries.splice(0, this.entries.length - KEEP)
    }
  }

  countOf(id: string): number {
    return this.counts.get(id) ?? 0
  }

  totalCount(): number {
    return this.total
  }

  /** 最近 n 条（新→旧） */
  recent(n: number): Entry[] {
    return this.entries.slice(-n).reverse()
  }

  /** 汇总：次数、档位/来源分布、平均与零命中、命中最多的条目 top */
  stats(top: number): Record<string, unknown> {
    let since = Number.MAX_VALUE
    let until = 0
    let sem = 0
    let rrf = 0
    let bm = 0
    let fb = 0
    let cli = 0
    let web = 0
    let hitSum = 0
    let zero = 0
    for (const e of this.entries) {
      since = Math.min(since, e.ts)
      until = Math.max(until, e.ts)
      if (e.backend === 'semantic') sem++
      else if (e.backend === 'rrf') rrf++
      else bm++
      if (e.fallback !== '') fb++
      if (e.source === 'web') web++
      else cli++
      if (e.hits.length === 0) zero++
      hitSum += e.hits.length
    }
    const n = this.entries.length
    // top 按次数排；标题取最近一次命中的
    const titleOf = new Map<string, string>()
    for (const e of [...this.entries].reverse()) {
      for (const h of e.hits) {
        if (!titleOf.has(h.id)) titleOf.set(h.id, h.title)
      }
    }
    // 次数降序，同次数按 id 升序（Map 迭代无序，不钉死顺序输出会抖）
    const topv = [...this.counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    const topArr = topv.slice(0, top).map(([id, c]) => ({ id, count: c, title: titleOf.get(id) ?? '' }))
    return {
      queries_window: n,
      queries_total: this.total,
      bad_lines: this.badLines,
      since: n > 0 ? since : 0.0,
      until,
      backend: { semantic: sem, rrf, bm25: bm },
      fallback_user: fb,
      source: { cli, web },
      hits_avg: n > 0 ? Math.round((hitSum / n) * 100) / 100 : 0.0,
      zero_hit: zero,
      distinct_recalled: this.counts.size,
      top: topArr,
    }
  }

  /** 最近条目的 JSON 视图（分数四舍五入到 4 位，别把 f32 噪声写进训练集） */
  recentJson(n: number): Array<Record<string, unknown>> {
    return this.recent(n).map((e) => ({
      ts: e.ts,
      query: e.query,
      backend: e.backend,
      limit: e.limit,
      fallback: e.fallback,
      source: e.source,
      ms: e.ms,
      hits: e.hits.map((h) => ({ id: h.id, score: round4(h.score), title: h.title })),
    }))
  }
}

/** 只落盘、不载内存（CLI 短进程用） */
export function appendLine(dataDir: string, e: Entry): void {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.appendFileSync(logPath(dataDir), entryJson(e) + '\n')
}

/** 导出训练集：每行一次查询 {ts, query, backend, fallback, limit, positive(ids 按名次), hits}
 * since 为 unix 秒下限（0＝全部）；返回导出条数 */
export function exportLog(dataDir: string, out: string, since: number): number {
  let text: string
  try {
    text = fs.readFileSync(logPath(dataDir), 'utf8')
  } catch (e) {
    throw new Error(`读日志失败: ${String(e)}`)
  }
  let n = 0
  const buf: string[] = []
  for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
    const e = parseEntry(line)
    if (e === null) continue
    if (e.ts < since) continue
    const v = {
      ts: e.ts,
      query: e.query,
      backend: e.backend,
      fallback: e.fallback,
      limit: e.limit,
      positive: e.hits.map((h) => h.id),
      hits: e.hits.map((h) => ({ id: h.id, score: round4(h.score), title: h.title })),
    }
    buf.push(JSON.stringify(v))
    n++
  }
  const dir = path.dirname(out)
  if (dir !== '' && dir !== '.') fs.mkdirSync(dir, { recursive: true })
  try {
    fs.writeFileSync(out, buf.length > 0 ? buf.join('\n') + '\n' : '')
  } catch (e) {
    throw new Error(`写导出文件失败: ${String(e)}`)
  }
  return n
}

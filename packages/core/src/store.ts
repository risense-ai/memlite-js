/**
 * 存储层：append-only JSONL + 16MB 分块轮转 + 内存索引。
 * 归档旧→新、活跃文件恒末，末写胜出（LWW）。
 * 与 Rust memlite store.rs 数据契约互通（compat.md §二）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

export const DATA_FILE = 'memory.jsonl'
export const CHUNK_BYTES = 16 * 1024 * 1024

/** 一条记忆（或 del 墓碑）。parent_id / importance / kind 等经 flatten 落在 extra。 */
export interface MemRecord {
  op: 'put' | 'del'
  id: string
  ts: number
  title: string
  content: string
  tags: string[]
  project: string
  extra: Record<string, unknown>
}

/** 因果树父指针：extra.parent_id（迁移库带此字段；无则空串=根）。 */
export function parentId(r: MemRecord): string {
  const v = r.extra['parent_id']
  return typeof v === 'string' ? v : ''
}

/** 版本字段：`extra.revision`（JSONL 平铺字段，Rust 侧 serde(flatten) 会原样保留）。 */
export const REVISION_KEY = 'revision'

/**
 * 一条记录的修订号（条件写的比较基准）。
 *
 * - 新写入的记录显式带 `revision: 0`；
 * - 旧数据（含 Rust CLI 写入、迁移库）没有该字段，用 `ts` 毫秒化作为稳定初值，
 *   这样两个并发的旧版本读者仍会拿到同一个初值，后写者能触发冲突；
 * - 负数/非整数按旧数据处理，不信任脏字段。
 */
export function recordRevision(r: MemRecord): number {
  const v = r.extra[REVISION_KEY]
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v
  return Number.isFinite(r.ts) ? Math.max(0, Math.round(r.ts * 1000)) : 0
}

/** 条件写冲突：expectedRevision 与当前库内版本不一致。 */
export class StaleVersionError extends Error {
  readonly code = 'STALE_VERSION'
  readonly currentRevision: number

  constructor(currentRevision: number) {
    super('版本冲突：记忆已被其他窗口修改')
    this.name = 'StaleVersionError'
    this.currentRevision = currentRevision
  }
}

/** 重要性（respire 迁移数据 important/trivial；新条可缺省）。 */
export function importance(r: MemRecord): string {
  const v = r.extra['importance']
  return typeof v === 'string' ? v : ''
}

/** 记忆形态（Context/Task/Skill/...；迁移库带，新条可缺省）。 */
export function kind(r: MemRecord): string {
  const v = r.extra['kind']
  return typeof v === 'string' ? v : ''
}

export function nowTs(): number {
  return Date.now() / 1000
}

export function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/** 序列化一行：固定字段在前，extra 平铺在后（对齐 serde flatten 形状）。 */
export function serializeRecord(r: MemRecord): string {
  const obj: Record<string, unknown> = {
    op: r.op,
    id: r.id,
    ts: r.ts,
    title: r.title,
    content: r.content,
    tags: r.tags,
    project: r.project,
  }
  for (const [k, v] of Object.entries(r.extra)) obj[k] = v
  return JSON.stringify(obj)
}

function parseRecord(line: string): MemRecord | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  if (o.op !== 'put' && o.op !== 'del') return null
  if (typeof o.id !== 'string' || typeof o.ts !== 'number') return null
  if (typeof o.content !== 'string') return null
  const known = new Set(['op', 'id', 'ts', 'title', 'content', 'tags', 'project'])
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (!known.has(k)) extra[k] = v
  }
  return {
    op: o.op,
    id: o.id,
    ts: o.ts,
    title: typeof o.title === 'string' ? o.title : '',
    content: o.content,
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    project: typeof o.project === 'string' ? o.project : '',
    extra,
  }
}

function emptyRecord(op: 'put' | 'del', id: string, ts: number): MemRecord {
  return { op, id, ts, title: '', content: '', tags: [], project: '', extra: {} }
}

function makePut(id: string, ts: number, content: string, title: string, tags: string[], project: string, extra: Record<string, unknown>): MemRecord {
  return { op: 'put', id, ts, title, content, tags, project, extra }
}

export class Store {
  readonly dataDir: string
  readonly records = new Map<string, MemRecord>()
  readonly deleted = new Set<string>()
  badLines = 0
  private readonly chunkBytes: number
  /** 上次加载/写入后看到的 memory*.jsonl 签名（size+mtime）；用于条件写前发现外部进程写入。 */
  private fileSignature = ''

  constructor(dataDir: string, chunkBytes = CHUNK_BYTES) {
    this.dataDir = dataDir
    this.chunkBytes = chunkBytes
    this.load()
    this.fileSignature = this.currentSignature()
  }

  /** 目录内全部 memory*.jsonl 的 size+mtime 签名（不含内容，开销有界）。 */
  private currentSignature(): string {
    const paths = this.files()
    const parts: string[] = []
    for (const p of paths) {
      try {
        const stat = fs.statSync(p)
        parts.push(`${path.basename(p)}:${stat.size}:${stat.mtimeMs}`)
      } catch {
        parts.push(`${path.basename(p)}:missing`)
      }
    }
    return parts.join('|')
  }

  /** 条件写前刷新：若其他进程追加/轮转了 JSONL，先重载索引再比较版本。 */
  private refreshExternal(): void {
    const signature = this.currentSignature()
    if (signature === this.fileSignature) return
    this.records.clear()
    this.deleted.clear()
    this.badLines = 0
    this.load()
    this.fileSignature = this.currentSignature()
  }

  /** 归档按序号升序（旧→新） */
  private archivePaths(): string[] {
    const found: Array<[number, string]> = []
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dataDir)
    } catch {
      return []
    }
    for (const name of names) {
      const m = /^memory-(\d+)\.jsonl$/.exec(name)
      if (m) found.push([Number(m[1]), path.join(this.dataDir, name)])
    }
    found.sort((a, b) => a[0] - b[0])
    return found.map(([, p]) => p)
  }

  /** 归档在前（旧），活跃在后（新） */
  private files(): string[] {
    const paths = this.archivePaths()
    const active = path.join(this.dataDir, DATA_FILE)
    if (fs.existsSync(active)) paths.push(active)
    return paths
  }

  private load(): void {
    for (const p of this.files()) {
      let text: string
      try {
        text = fs.readFileSync(p, 'utf8')
      } catch {
        continue
      }
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        const rec = parseRecord(line)
        if (rec === null) {
          this.badLines++
          continue
        }
        this.apply(rec)
      }
    }
  }

  private apply(op: MemRecord): void {
    if (op.op === 'put') {
      this.records.set(op.id, op)
      this.deleted.delete(op.id)
    } else {
      this.deleted.add(op.id)
      this.records.delete(op.id)
    }
  }

  private append(rec: MemRecord): void {
    fs.mkdirSync(this.dataDir, { recursive: true })
    const active = path.join(this.dataDir, DATA_FILE)
    const line = serializeRecord(rec)
    const fd = fs.openSync(active, 'a')
    try {
      fs.writeSync(fd, line + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    this.maybeRotate()
    this.fileSignature = this.currentSignature()
  }

  /** 活跃文件超限即轮转（改名归档，取最大序号+1） */
  private maybeRotate(): void {
    const active = path.join(this.dataDir, DATA_FILE)
    let size = 0
    try {
      size = fs.statSync(active).size
    } catch {
      return
    }
    if (size < this.chunkBytes) return
    const archives = this.archivePaths()
    let maxSeq = 0
    if (archives.length > 0) {
      const last = archives[archives.length - 1]
      const m = /^memory-(\d+)\.jsonl$/.exec(path.basename(last))
      if (m) maxSeq = Number(m[1])
    }
    const seq = maxSeq + 1
    fs.renameSync(active, path.join(this.dataDir, `memory-${String(seq).padStart(4, '0')}.jsonl`))
  }

  put(content: string, title: string, tags: string[], project: string): string {
    return this.putChild(content, title, tags, project, '')
  }

  /** 存一条并显式认因（parent 非空须已在库——不产生悬空父指针；空串=根）。 */
  putChild(content: string, title: string, tags: string[], project: string, parent: string): string {
    if (content.trim() === '') throw new Error('content 为空')
    if (parent !== '' && !this.records.has(parent)) {
      throw new Error(`目标因（父）不存在: ${parent}`)
    }
    const rid = newId()
    const rec = makePut(rid, nowTs(), content.trim(), title.trim(), cleanTags(tags), project.trim(), {
      parent_id: parent,
      revision: 0,
    })
    this.append(rec)
    this.apply(rec)
    return rid
  }

  delete(rid: string): void {
    if (!this.records.has(rid)) throw new Error(`记忆不存在: ${rid}`)
    const rec = emptyRecord('del', rid, nowTs())
    this.append(rec)
    this.apply(rec)
  }

  /** 就地改：同 id 追加新 put（末写胜出，id 不变）。
   * extra 全量保留（parent_id/importance/kind 随迁——改前文不能丢因链）；
   * extraPatch 非空时按键合并覆盖（parent_id 仍以库中原值为准，改挂走 reparent）。 */
  putWithId(rid: string, content: string, title: string, tags: string[], project: string, extraPatch?: Record<string, unknown>): void {
    if (content.trim() === '') throw new Error('content 为空')
    const old = this.records.get(rid)
    const extra: Record<string, unknown> = { ...old?.extra, ...extraPatch }
    extra['parent_id'] = old ? parentId(old) : ''
    extra[REVISION_KEY] = old ? recordRevision(old) + 1 : 0
    const rec = makePut(rid, nowTs(), content.trim(), title.trim(), cleanTags(tags), project.trim(), extra)
    this.append(rec)
    this.apply(rec)
  }

  /** 条件写：当前 revision 必须等于 expectedRevision，否则抛 StaleVersionError。
   * 检查与写入在同一同步调用内完成，进程内并发不会出现检查—写入间隙。 */
  putWithIdConditional(
    rid: string,
    content: string,
    title: string,
    tags: string[],
    project: string,
    expectedRevision: number,
    extraPatch?: Record<string, unknown>,
  ): void {
    this.refreshExternal()
    if (content.trim() === '') throw new Error('content 为空')
    const old = this.records.get(rid)
    if (!old) throw new Error(`记忆不存在: ${rid}`)
    this.assertRevision(old, expectedRevision)
    this.putWithId(rid, content, title, tags, project, extraPatch)
  }

  private assertRevision(record: MemRecord, expectedRevision: number): void {
    const current = recordRevision(record)
    if (!Number.isSafeInteger(expectedRevision) || current !== expectedRevision) {
      throw new StaleVersionError(current)
    }
  }

  /** 改挂条件写：版本不一致即冲突；防环仍由 reparentChecked 保证。 */
  reparentCheckedConditional(rid: string, newParent: string, expectedRevision: number): void {
    this.refreshExternal()
    const old = this.records.get(rid)
    if (!old) throw new Error(`记忆不存在: ${rid}`)
    this.assertRevision(old, expectedRevision)
    this.reparentChecked(rid, newParent)
  }

  /** 忘记条件写：版本不一致即冲突；删除后当前索引不再有该 id。 */
  deleteConditional(rid: string, expectedRevision: number): void {
    this.refreshExternal()
    const old = this.records.get(rid)
    if (!old) throw new Error(`记忆不存在: ${rid}`)
    this.assertRevision(old, expectedRevision)
    this.delete(rid)
  }

  /** 完整受控存入：显式 id/ts/extra（导入桥等客户端用）；parent 非空须已在库。
   * id 已在库即拒（改条走 update 流）；extra 中夹带的 parent_id 以 parent 参数为准。 */
  putFull(p: {
    id?: string
    ts?: number
    content: string
    title: string
    tags?: string[]
    project?: string
    parent?: string
    extra?: Record<string, unknown>
  }): string {
    if (p.content.trim() === '') throw new Error('content 为空')
    if (p.id !== undefined && this.records.has(p.id)) {
      throw new Error(`id 已存在（改条走 update 流）: ${p.id}`)
    }
    const parent = p.parent ?? ''
    if (parent !== '' && !this.records.has(parent)) {
      throw new Error(`目标因（父）不存在: ${parent}`)
    }
    const rid = p.id ?? newId()
    const extra: Record<string, unknown> = { ...(p.extra ?? {}) }
    extra['parent_id'] = parent
    const rawRevision = extra[REVISION_KEY]
    extra[REVISION_KEY] =
      typeof rawRevision === 'number' && Number.isSafeInteger(rawRevision) && rawRevision >= 0
        ? rawRevision
        : 0
    const rec = makePut(rid, p.ts ?? nowTs(), p.content.trim(), p.title.trim(), cleanTags(p.tags ?? []), (p.project ?? '').trim(), extra)
    this.append(rec)
    this.apply(rec)
    return rid
  }

  /** 改挂因（新父）：追加同 id 新 put，仅换 parent_id（空串=升根）。
   * ts 保留原值：改挂是结构调整，不该把老条顶进「最近」时间线。
   * 防环由调用方查证（reparentChecked）；本函数只保证两节点存在。 */
  reparent(rid: string, newParent: string): void {
    const old = this.records.get(rid)
    if (!old) throw new Error(`记忆不存在: ${rid}`)
    if (newParent !== '' && !this.records.has(newParent)) {
      throw new Error(`目标因（父）不存在: ${newParent}`)
    }
    const rec: MemRecord = {
      ...old,
      extra: { ...old.extra, parent_id: newParent, [REVISION_KEY]: recordRevision(old) + 1 },
    }
    this.append(rec)
    this.apply(rec)
  }

  /** 改挂带防环：新父不得为本条、也不得在本条因链上（即新父是本条后代）。 */
  reparentChecked(rid: string, newParent: string): void {
    if (rid === newParent) throw new Error('不能挂自己')
    if (newParent !== '') {
      for (const anc of this.ancestorChain(newParent)) {
        if (anc === rid) throw new Error('防环：新父是本条的后代')
      }
    }
    this.reparent(rid, newParent)
  }

  /** 因链回溯（父→祖父→…），返回**自根至父**顺序（不含本条）。
   * 防环封顶 64 层（脏数据不挂死）；父不在库即断链止步。 */
  ancestorChain(rid: string): string[] {
    const chain: string[] = []
    let cur = rid
    for (let i = 0; i < 64; i++) {
      const rec = this.records.get(cur)
      if (!rec) break
      const pid = parentId(rec)
      if (pid === '') break
      chain.push(pid)
      cur = pid
    }
    chain.reverse()
    return chain
  }

  /** 直接子条（果），按 ts 升序（存入序，树渲染稳定）。 */
  children(rid: string): MemRecord[] {
    const v: MemRecord[] = []
    for (const r of this.records.values()) {
      if (parentId(r) === rid) v.push(r)
    }
    v.sort((a, b) => a.ts - b.ts)
    return v
  }

  /** 根集：parent_id 为空（含老数据无此字段）。 */
  roots(): MemRecord[] {
    const v: MemRecord[] = []
    for (const r of this.records.values()) {
      if (parentId(r) === '') v.push(r)
    }
    v.sort((a, b) => a.ts - b.ts)
    return v
  }

  count(): number {
    return this.records.size
  }

  all(): MemRecord[] {
    return [...this.records.values()]
  }

  get(rid: string): MemRecord | undefined {
    return this.records.get(rid)
  }

  /** id / 纲名（精确标题唯一命中）/ 前缀 三级解析——与 respire resolve_prefix 同序。 */
  resolve(prefix: string): MemRecord | undefined {
    const p = prefix.replace(/^#+/, '')
    const exact = this.records.get(p)
    if (exact) return exact
    // 纲名直挂：精确标题唯一命中即取（词库纲名即挂载名）
    const byTitle = [...this.records.values()].filter((r) => r.title === p)
    if (byTitle.length === 1) return byTitle[0]
    const byPrefix = [...this.records.values()].filter((r) => r.id.startsWith(p))
    const first = byPrefix[0]
    if (byPrefix.length === 0) return undefined
    if (byPrefix.length > 1) return undefined // 歧义
    return first
  }

  /** 同 id 的全部历史版本（append-only 日志天然保历史）：按文件序（旧→新）。 */
  versions(rid: string): MemRecord[] {
    const out: MemRecord[] = []
    for (const p of this.files()) {
      let text: string
      try {
        text = fs.readFileSync(p, 'utf8')
      } catch {
        continue
      }
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        const rec = parseRecord(line)
        if (rec && rec.op === 'put' && rec.id === rid) out.push(rec)
      }
    }
    return out
  }

  /** 全库标签频次（降序，同次数按标签升序） */
  tagCounts(): Array<[string, number]> {
    const m = new Map<string, number>()
    for (const r of this.records.values()) {
      for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1)
    }
    return sortCounts(m)
  }

  /** 全库 project 频次（降序，空 project 归「（无）」） */
  projectCounts(): Array<[string, number]> {
    const m = new Map<string, number>()
    for (const r of this.records.values()) {
      const k = r.project === '' ? '（无）' : r.project
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return sortCounts(m)
  }

  lineCount(): number {
    let n = 0
    for (const p of this.files()) {
      try {
        n += fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').length
      } catch {
        // 读不到按 0 计
      }
    }
    return n
  }

  fileStats(): Array<[string, number]> {
    return this.files().map((p) => {
      let size = 0
      try {
        size = fs.statSync(p).size
      } catch {
        // 读不到按 0 计
      }
      return [path.basename(p), size] as [string, number]
    })
  }

  /** 压实：只留存活重写回单文件，删归档。返回压实前行数。 */
  compact(): number {
    const before = this.lineCount()
    const active = path.join(this.dataDir, DATA_FILE)
    const tmp = path.join(this.dataDir, `${DATA_FILE}.tmp`)
    const fd = fs.openSync(tmp, 'w')
    try {
      const recs = [...this.records.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
      for (const rec of recs) fs.writeSync(fd, serializeRecord(rec) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    for (const p of this.archivePaths()) fs.rmSync(p)
    fs.renameSync(tmp, active)
    return before
  }
}

function cleanTags(tags: string[]): string[] {
  return tags.map((t) => t.trim()).filter((t) => t !== '')
}

function sortCounts(m: Map<string, number>): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

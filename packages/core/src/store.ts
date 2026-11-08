/**
 * 存储层：append-only JSONL + 16MB 分块轮转 + 内存索引。
 * 归档旧→新、活跃文件恒末，末写胜出（LWW）。
 * 与 Rust memlite store.rs 数据契约互通（compat.md §二）。
 *
 * 并发协议（concurrency-proposal.md §3）：
 * - 公开读取走数据共享锁，并在锁内检查代次；变化即重载。
 * - 所有写入统一走数据排他锁：锁内重载 → 校验父/版本/防环/唯一性 → 追加 → fsync → 轮转。
 * - Store 的低层读取方法仍保留为未加锁原语；宿主应优先使用 `snapshot()` 取同一代次视图。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ConcurrencyError,
  LockManager,
  detectFilesystem,
  probeNfs,
  resolveConcurrency,
  type ConcurrencyConfig,
  type FilesystemInfo,
  type ResolvedConcurrency,
} from './lock'

export const DATA_FILE = 'memory.jsonl'
export const CHUNK_BYTES = 16 * 1024 * 1024
export const META_FILE = 'meta.json'
export const STORAGE_PROTOCOL = 1

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

function makePut(
  id: string,
  ts: number,
  content: string,
  title: string,
  tags: string[],
  project: string,
  extra: Record<string, unknown>,
): MemRecord {
  return { op: 'put', id, ts, title, content, tags, project, extra }
}

/** 同一代次的只读视图：锁释放后仍保持内容一致。 */
export class StoreSnapshot {
  readonly records: ReadonlyMap<string, MemRecord>
  readonly deleted: ReadonlySet<string>
  readonly badLines: number
  readonly generation: string
  private readonly kids: Map<string, MemRecord[]>
  private readonly rootRecords: MemRecord[]

  constructor(
    records: ReadonlyMap<string, MemRecord>,
    deleted: ReadonlySet<string>,
    badLines: number,
    generation: string,
  ) {
    this.records = records
    this.deleted = deleted
    this.badLines = badLines
    this.generation = generation
    this.kids = new Map()
    for (const r of records.values()) {
      const p = parentId(r)
      if (p !== '') {
        const list = this.kids.get(p)
        if (list) list.push(r)
        else this.kids.set(p, [r])
      }
    }
    for (const list of this.kids.values()) list.sort((a, b) => a.ts - b.ts)
    this.rootRecords = [...records.values()]
      .filter((r) => parentId(r) === '')
      .sort((a, b) => a.ts - b.ts)
  }

  all(): MemRecord[] {
    return [...this.records.values()]
  }

  count(): number {
    return this.records.size
  }

  get(rid: string): MemRecord | undefined {
    return this.records.get(rid)
  }

  /** id / 纲名（精确标题唯一命中）/ 前缀 三级解析——与 respire resolve_prefix 同序。 */
  resolve(prefix: string): MemRecord | undefined {
    return resolveInRecords(this.records, prefix)
  }

  /** 直接子条（果），按 ts 升序。 */
  children(rid: string): MemRecord[] {
    return [...(this.kids.get(rid) ?? [])]
  }

  roots(): MemRecord[] {
    return [...this.rootRecords]
  }

  tagCounts(): Array<[string, number]> {
    const m = new Map<string, number>()
    for (const r of this.records.values()) {
      for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1)
    }
    return sortCounts(m)
  }

  projectCounts(): Array<[string, number]> {
    const m = new Map<string, number>()
    for (const r of this.records.values()) {
      const k = r.project === '' ? '（无）' : r.project
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return sortCounts(m)
  }

  /** 因链回溯（父→祖父→…），返回自根至父顺序（不含本条）。 */
  ancestorChain(rid: string): string[] {
    return ancestorChainIn(this.records, rid)
  }
}

function resolveInRecords(
  records: ReadonlyMap<string, MemRecord>,
  prefix: string,
): MemRecord | undefined {
  const p = prefix.replace(/^#+/, '')
  const exact = records.get(p)
  if (exact) return exact
  const byTitle = [...records.values()].filter((r) => r.title === p)
  if (byTitle.length === 1) return byTitle[0]
  const byPrefix = [...records.values()].filter((r) => r.id.startsWith(p))
  if (byPrefix.length === 1) return byPrefix[0]
  return undefined
}

function ancestorChainIn(records: ReadonlyMap<string, MemRecord>, rid: string): string[] {
  const chain: string[] = []
  let cur = rid
  for (let i = 0; i < 64; i++) {
    const rec = records.get(cur)
    if (!rec) break
    const pid = parentId(rec)
    if (pid === '') break
    chain.push(pid)
    cur = pid
  }
  chain.reverse()
  return chain
}

/** 树渲染/链查询只依赖这组读取能力；Store 与 StoreSnapshot 都实现。 */
export interface TreeSource {
  readonly records: ReadonlyMap<string, MemRecord>
  all(): MemRecord[]
  children(rid: string): MemRecord[]
  ancestorChain(rid: string): string[]
}

export interface StoreOptions {
  concurrency?: ConcurrencyConfig
  logger?: { warn(msg: string): void }
  /** 测试用：false 强制进程内锁；生产默认自动探测 */
  nativeLock?: boolean
}

export interface StoreConcurrencyStatus {
  mode: ResolvedConcurrency['mode']
  filesystem: ResolvedConcurrency['filesystem']
  filesystem_type: string
  lock_backend: string
  cross_process: boolean
  lock_timeout_ms: number
  storage_protocol: number
  generation: string
}

export class Store implements TreeSource {
  readonly dataDir: string
  readonly records = new Map<string, MemRecord>()
  readonly deleted = new Set<string>()
  badLines = 0
  private readonly chunkBytes: number
  private readonly lock: LockManager
  private readonly logger: { warn(msg: string): void }
  private loadedGeneration = ''
  private readonly filesystemInfo: FilesystemInfo
  private storageProtocol = 0

  constructor(dataDir: string, chunkBytes = CHUNK_BYTES, options: StoreOptions = {}) {
    this.dataDir = dataDir
    this.chunkBytes = chunkBytes
    this.logger = options.logger ?? { warn: () => {} }
    this.lock = new LockManager({
      dataDir,
      concurrency: options.concurrency,
      logger: this.logger,
      native: options.nativeLock,
    })
    this.lock.warnIfDegraded()
    this.filesystemInfo = fs.existsSync(dataDir)
      ? detectFilesystem(dataDir)
      : { kind: 'unknown', type: '', mount: '' }
    this.assertFilesystem()
    this.storageProtocol = this.readStorageProtocol()
    this.lock.withLock(
      'data',
      'shared',
      'open',
      () => {
        this.loadLocked()
        this.loadedGeneration = this.computeGenerationLocked()
      },
      { createDir: false },
    )
    if (this.loadedGeneration === '') this.loadedGeneration = this.computeGeneration()
  }

  private assertFilesystem(): void {
    const cfg = this.lock.concurrency
    if (!fs.existsSync(this.dataDir)) return
    if (cfg.filesystem === 'nfs') {
      const probe = probeNfs(this.dataDir, cfg.lockTimeoutMs)
      if (!probe.ok) {
        throw new ConcurrencyError('NFS_PROBE_FAILED', 'NFS 探针失败：该挂载不能用于共享写入', {
          dataDir: this.dataDir,
          operation: 'open',
          advice: '改用本地目录 + memlite sync，或换用通过探针的 NFS 客户端/服务端组合',
        })
      }
      return
    }
    if (this.filesystemInfo.kind === 'network') {
      throw new ConcurrencyError(
        'UNSUPPORTED_FILESYSTEM',
        `检测到网络文件系统（${this.filesystemInfo.type}），未显式配置 filesystem=nfs`,
        {
          dataDir: this.dataDir,
          operation: 'open',
          advice: '改用本地目录 + memlite sync；确需 NFS 时显式设置 concurrency.filesystem=nfs 并通过探针',
        },
      )
    }
  }

  /** 共享读锁内取同一代次快照；锁释放后视图仍一致。 */
  snapshot(operation = 'snapshot'): StoreSnapshot {
    return this.lock.withLock(
      'data',
      'shared',
      operation,
      () => {
        this.refreshLocked()
        return this.makeSnapshot()
      },
      { createDir: false },
    )
  }

  /** 在数据共享锁内执行回调，回调可使用同一代次快照（向量写前的 revision 校验用）。 */
  withSnapshot<T>(operation: string, fn: (snap: StoreSnapshot) => T): T {
    return this.lock.withLock(
      'data',
      'shared',
      operation,
      () => {
        this.refreshLocked()
        return fn(this.makeSnapshot())
      },
      { createDir: false },
    )
  }

  private makeSnapshot(): StoreSnapshot {
    return new StoreSnapshot(
      new Map(this.records),
      new Set(this.deleted),
      this.badLines,
      this.loadedGeneration,
    )
  }

  /** 目录内全部 memory*.jsonl 的元数据签名（size+mtime+inode）。 */
  private computeGenerationLocked(): string {
    const paths = this.filesLocked()
    if (paths.length === 0) return ''
    const parts: string[] = []
    for (const p of paths) {
      try {
        const stat = fs.statSync(p, { bigint: true })
        parts.push(
          `${path.basename(p)}:${stat.size}:${stat.mtimeNs}:${stat.ino}`,
        )
      } catch {
        parts.push(`${path.basename(p)}:missing`)
      }
    }
    return parts.join('|')
  }

  /** 当前代次（不持锁；状态展示用）。 */
  generation(): string {
    return this.computeGeneration()
  }

  private computeGeneration(): string {
    return this.computeGenerationLocked()
  }

  /** 锁内检查代次；变化即全量重载。 */
  private refreshLocked(): void {
    const signature = this.computeGenerationLocked()
    if (signature === this.loadedGeneration) return
    this.loadLocked()
    this.loadedGeneration = signature
  }

  /** 归档按序号升序（旧→新） */
  private archivePathsLocked(): string[] {
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
  private filesLocked(): string[] {
    const paths = this.archivePathsLocked()
    const active = path.join(this.dataDir, DATA_FILE)
    if (fs.existsSync(active)) paths.push(active)
    return paths
  }

  private loadLocked(): void {
    this.records.clear()
    this.deleted.clear()
    this.badLines = 0
    for (const p of this.filesLocked()) {
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
        this.applyLocked(rec)
      }
    }
  }

  private applyLocked(op: MemRecord): void {
    if (op.op === 'put') {
      this.records.set(op.id, op)
      this.deleted.delete(op.id)
    } else {
      this.deleted.add(op.id)
      this.records.delete(op.id)
    }
  }

  /**
   * 统一提交入口：数据排他锁 → 重载最新快照 → 业务校验 → 追加 → fsync → 轮转。
   * 回调里只能用 *Locked 原语，禁止再获取数据锁。
   */
  private withWrite<T>(operation: string, fn: () => T): T {
    return this.lock.withLock(
      'data',
      'exclusive',
      operation,
      () => {
        this.refreshLocked()
        this.cleanupTempsLocked()
        this.ensureProtocolMetaLocked()
        const result = fn()
        this.loadedGeneration = this.computeGenerationLocked()
        return result
      },
      { createDir: true },
    )
  }

  /** 数据排他锁内清理本协议（且只可能是本协议）遗留的临时文件。 */
  private cleanupTempsLocked(): void {
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dataDir)
    } catch {
      return
    }
    for (const name of names) {
      if (/^memory\.jsonl\.\d+\.[0-9a-f]+\.tmp$/.test(name)) {
        const file = path.join(this.dataDir, name)
        try {
          const stat = fs.statSync(file)
          // 只清理一小时前的残留；近期的完整 tmp 保留给人工恢复
          if (Date.now() - stat.mtimeMs > 3_600_000) fs.rmSync(file, { force: true })
        } catch {
          // 清理失败不阻塞提交；下次写入再试
        }
      }
    }
  }

  private appendLocked(rec: MemRecord): void {
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
    this.maybeRotateLocked()
  }

  /** 活跃文件超限即轮转（改名归档，取最大序号+1）；必须在数据排他锁内调用。 */
  private maybeRotateLocked(): void {
    const active = path.join(this.dataDir, DATA_FILE)
    let size = 0
    try {
      size = fs.statSync(active).size
    } catch {
      return
    }
    if (size < this.chunkBytes) return
    const archives = this.archivePathsLocked()
    let maxSeq = 0
    if (archives.length > 0) {
      const last = archives[archives.length - 1]
      const m = /^memory-(\d+)\.jsonl$/.exec(path.basename(last))
      if (m) maxSeq = Number(m[1])
    }
    const seq = maxSeq + 1
    fs.renameSync(active, path.join(this.dataDir, `memory-${String(seq).padStart(4, '0')}.jsonl`))
  }

  /** 首次写入标记 storage_protocol=1；保留 meta.json 其他字段。 */
  private ensureProtocolMetaLocked(): void {
    if (this.storageProtocol >= STORAGE_PROTOCOL) return
    const file = path.join(this.dataDir, META_FILE)
    let meta: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>
      }
    } catch {
      meta = {}
    }
    meta['storage_protocol'] = STORAGE_PROTOCOL
    atomicWriteJson(file, meta)
    this.storageProtocol = STORAGE_PROTOCOL
  }

  private readStorageProtocol(): number {
    const file = path.join(this.dataDir, META_FILE)
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      const v = parsed['storage_protocol']
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v
    } catch {
      // 无 meta 或坏 JSON：按旧库处理
    }
    return 0
  }

  /** 低层未加锁原语：只在已持锁或单线程构造阶段使用。 */
  peek(rid: string): MemRecord | undefined {
    return this.records.get(rid)
  }

  put(content: string, title: string, tags: string[], project: string): string {
    return this.putChild(content, title, tags, project, '')
  }

  /** 存一条并显式认因（parent 非空须已在库——不产生悬空父指针；空串=根）。 */
  putChild(
    content: string,
    title: string,
    tags: string[],
    project: string,
    parent: string,
  ): string {
    if (content.trim() === '') throw new Error('content 为空')
    return this.withWrite('putChild', () => {
      if (content.trim() === '') throw new Error('content 为空')
      if (parent !== '' && !this.records.has(parent)) {
        throw new Error(`目标因（父）不存在: ${parent}`)
      }
      const rid = newId()
      const rec = makePut(
        rid,
        nowTs(),
        content.trim(),
        title.trim(),
        cleanTags(tags),
        project.trim(),
        { parent_id: parent, revision: 0 },
      )
      this.appendLocked(rec)
      this.applyLocked(rec)
      return rid
    })
  }

  delete(rid: string): void {
    this.withWrite('delete', () => {
      if (!this.records.has(rid)) throw new Error(`记忆不存在: ${rid}`)
      this.deleteLocked(rid)
    })
  }

  private deleteLocked(rid: string): void {
    const rec = emptyRecord('del', rid, nowTs())
    this.appendLocked(rec)
    this.applyLocked(rec)
  }

  /** 就地改：同 id 追加新 put（末写胜出，id 不变）。extra 全量保留；extraPatch 按键合并覆盖。 */
  putWithId(
    rid: string,
    content: string,
    title: string,
    tags: string[],
    project: string,
    extraPatch?: Record<string, unknown>,
  ): void {
    this.withWrite('putWithId', () => {
      this.putWithIdLocked(rid, content, title, tags, project, extraPatch)
    })
  }

  private putWithIdLocked(
    rid: string,
    content: string,
    title: string,
    tags: string[],
    project: string,
    extraPatch?: Record<string, unknown>,
  ): void {
    if (content.trim() === '') throw new Error('content 为空')
    const old = this.records.get(rid)
    const extra: Record<string, unknown> = { ...old?.extra, ...extraPatch }
    extra['parent_id'] = old ? parentId(old) : ''
    extra[REVISION_KEY] = old ? recordRevision(old) + 1 : 0
    const rec = makePut(
      rid,
      nowTs(),
      content.trim(),
      title.trim(),
      cleanTags(tags),
      project.trim(),
      extra,
    )
    this.appendLocked(rec)
    this.applyLocked(rec)
  }

  /** 条件写：锁内重读后 revision 必须等于 expectedRevision，否则抛 StaleVersionError。 */
  putWithIdConditional(
    rid: string,
    content: string,
    title: string,
    tags: string[],
    project: string,
    expectedRevision: number,
    extraPatch?: Record<string, unknown>,
  ): void {
    this.withWrite('putWithIdConditional', () => {
      if (content.trim() === '') throw new Error('content 为空')
      const old = this.records.get(rid)
      if (!old) throw new Error(`记忆不存在: ${rid}`)
      this.assertRevision(old, expectedRevision)
      this.putWithIdLocked(rid, content, title, tags, project, extraPatch)
    })
  }

  private assertRevision(record: MemRecord, expectedRevision: number): void {
    const current = recordRevision(record)
    if (!Number.isSafeInteger(expectedRevision) || current !== expectedRevision) {
      throw new StaleVersionError(current)
    }
  }

  /** 改挂条件写：版本不一致即冲突；防环在锁内基于最新快照判断。 */
  reparentCheckedConditional(rid: string, newParent: string, expectedRevision: number): void {
    this.withWrite('reparentCheckedConditional', () => {
      const old = this.records.get(rid)
      if (!old) throw new Error(`记忆不存在: ${rid}`)
      this.assertRevision(old, expectedRevision)
      this.reparentCheckedLocked(rid, newParent)
    })
  }

  /** 忘记条件写：版本不一致即冲突；删除后当前索引不再有该 id。 */
  deleteConditional(rid: string, expectedRevision: number): void {
    this.withWrite('deleteConditional', () => {
      const old = this.records.get(rid)
      if (!old) throw new Error(`记忆不存在: ${rid}`)
      this.assertRevision(old, expectedRevision)
      this.deleteLocked(rid)
    })
  }

  /** 完整受控存入：显式 id/ts/extra（导入桥等客户端用）；parent 非空须已在库。 */
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
    return this.withWrite('putFull', () => {
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
      const rec = makePut(
        rid,
        p.ts ?? nowTs(),
        p.content.trim(),
        p.title.trim(),
        cleanTags(p.tags ?? []),
        (p.project ?? '').trim(),
        extra,
      )
      this.appendLocked(rec)
      this.applyLocked(rec)
      return rid
    })
  }

  /** 改挂因（新父）：追加同 id 新 put，仅换 parent_id（空串=升根）。 */
  reparent(rid: string, newParent: string): void {
    this.withWrite('reparent', () => {
      this.reparentLocked(rid, newParent)
    })
  }

  private reparentLocked(rid: string, newParent: string): void {
    const old = this.records.get(rid)
    if (!old) throw new Error(`记忆不存在: ${rid}`)
    if (newParent !== '' && !this.records.has(newParent)) {
      throw new Error(`目标因（父）不存在: ${newParent}`)
    }
    const rec: MemRecord = {
      ...old,
      extra: { ...old.extra, parent_id: newParent, [REVISION_KEY]: recordRevision(old) + 1 },
    }
    this.appendLocked(rec)
    this.applyLocked(rec)
  }

  /** 改挂带防环：新父不得为本条、也不得在本条因链上（即新父是本条后代）。 */
  reparentChecked(rid: string, newParent: string): void {
    this.withWrite('reparentChecked', () => {
      this.reparentCheckedLocked(rid, newParent)
    })
  }

  private reparentCheckedLocked(rid: string, newParent: string): void {
    if (rid === newParent) throw new Error('不能挂自己')
    if (newParent !== '') {
      for (const anc of ancestorChainIn(this.records, newParent)) {
        if (anc === rid) throw new Error('防环：新父是本条的后代')
      }
    }
    this.reparentLocked(rid, newParent)
  }

  /** 因链回溯（父→祖父→…），返回**自根至父**顺序（不含本条）。 */
  ancestorChain(rid: string): string[] {
    return this.withRead('ancestorChain', () => ancestorChainIn(this.records, rid))
  }

  /** 直接子条（果），按 ts 升序（存入序，树渲染稳定）。 */
  children(rid: string): MemRecord[] {
    return this.withRead('children', () => childrenIn(this.records, rid))
  }

  /** 根集：parent_id 为空（含老数据无此字段）。 */
  roots(): MemRecord[] {
    return this.withRead('roots', () =>
      [...this.records.values()].filter((r) => parentId(r) === '').sort((a, b) => a.ts - b.ts),
    )
  }

  count(): number {
    return this.withRead('count', () => this.records.size)
  }

  all(): MemRecord[] {
    return this.withRead('all', () => [...this.records.values()])
  }

  get(rid: string): MemRecord | undefined {
    return this.withRead('get', () => this.records.get(rid))
  }

  /** id / 纲名（精确标题唯一命中）/ 前缀 三级解析——与 respire resolve_prefix 同序。 */
  resolve(prefix: string): MemRecord | undefined {
    return this.withRead('resolve', () => resolveInRecords(this.records, prefix))
  }

  /** 同 id 的全部历史版本（append-only 日志天然保历史）：按文件序（旧→新）。 */
  versions(rid: string): MemRecord[] {
    return this.withRead('versions', () => {
      const out: MemRecord[] = []
      for (const p of this.filesLocked()) {
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
    })
  }

  /** 全库标签频次（降序，同次数按标签升序） */
  tagCounts(): Array<[string, number]> {
    return this.withRead('tagCounts', () => {
      const m = new Map<string, number>()
      for (const r of this.records.values()) {
        for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1)
      }
      return sortCounts(m)
    })
  }

  /** 全库 project 频次（降序，空 project 归「（无）」） */
  projectCounts(): Array<[string, number]> {
    return this.withRead('projectCounts', () => {
      const m = new Map<string, number>()
      for (const r of this.records.values()) {
        const k = r.project === '' ? '（无）' : r.project
        m.set(k, (m.get(k) ?? 0) + 1)
      }
      return sortCounts(m)
    })
  }

  lineCount(): number {
    return this.withRead('lineCount', () => this.lineCountLocked())
  }

  private lineCountLocked(): number {
    let n = 0
    for (const p of this.filesLocked()) {
      try {
        n += fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').length
      } catch {
        // 读不到按 0 计
      }
    }
    return n
  }

  fileStats(): Array<[string, number]> {
    return this.withRead('fileStats', () =>
      this.filesLocked().map((p) => {
        let size = 0
        try {
          size = fs.statSync(p).size
        } catch {
          // 读不到按 0 计
        }
        return [path.basename(p), size] as [string, number]
      }),
    )
  }

  /** 压实：只留存活重写回单文件，原子替换活跃文件后再删归档。返回压实前行数。 */
  compact(): number {
    return this.withWrite('compact', () => {
      const before = this.lineCountLocked()
      const active = path.join(this.dataDir, DATA_FILE)
      const tmp = path.join(
        this.dataDir,
        `${DATA_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
      )
      const records = [...this.records.values()].sort(
        (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1),
      )
      const fd = fs.openSync(tmp, 'w')
      try {
        for (const rec of records) fs.writeSync(fd, serializeRecord(rec) + '\n')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      try {
        fs.renameSync(tmp, active)
      } catch (e) {
        throw new ConcurrencyError('COMPACT_FAILED', `压实替换活跃文件失败: ${String(e)}`, {
          dataDir: this.dataDir,
          operation: 'compact',
          advice: `保留完整临时文件 ${path.basename(tmp)}，检查权限后重试`,
        })
      }
      for (const p of this.archivePathsLocked()) {
        try {
          fs.rmSync(p)
        } catch (e) {
          throw new ConcurrencyError('COMPACT_FAILED', `压实后删除归档失败: ${String(e)}`, {
            dataDir: this.dataDir,
            operation: 'compact',
            advice: '活跃文件已替换；手工清理归档前先备份',
          })
        }
      }
      syncDir(this.dataDir)
      this.loadedGeneration = this.computeGenerationLocked()
      return before
    })
  }

  /** 锁内共享读：检查代次后执行。 */
  private withRead<T>(operation: string, fn: () => T): T {
    return this.lock.withLock(
      'data',
      'shared',
      operation,
      () => {
        this.refreshLocked()
        return fn()
      },
      { createDir: false },
    )
  }

  /** 宿主状态面板：锁后端、模式、文件系统与代次。 */
  concurrencyStatus(): StoreConcurrencyStatus {
    return {
      mode: this.lock.concurrency.mode,
      filesystem: this.lock.concurrency.filesystem,
      filesystem_type: this.filesystemInfo.type,
      lock_backend: this.lock.backend,
      cross_process: this.lock.crossProcess,
      lock_timeout_ms: this.lock.concurrency.lockTimeoutMs,
      storage_protocol: Math.max(this.storageProtocol, this.readStorageProtocol()),
      generation: this.generation(),
    }
  }

  /** 应用配置变更后重新解析并发（新 Store 实例会重新走构造；此处只校验）。 */
  resolveConcurrency(config?: ConcurrencyConfig): ResolvedConcurrency {
    return resolveConcurrency(config)
  }
}

function childrenIn(records: ReadonlyMap<string, MemRecord>, rid: string): MemRecord[] {
  const v: MemRecord[] = []
  for (const r of records.values()) {
    if (parentId(r) === rid) v.push(r)
  }
  v.sort((a, b) => a.ts - b.ts)
  return v
}

function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  syncDir(path.dirname(file))
}

function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // 目录 fsync 在部分平台/文件系统不支持；失败不改变已完成的原子替换。
  }
}

function cleanTags(tags: string[]): string[] {
  return tags.map((t) => t.trim()).filter((t) => t !== '')
}

function sortCounts(m: Map<string, number>): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

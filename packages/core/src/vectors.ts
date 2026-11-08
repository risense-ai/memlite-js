/**
 * 向量侧车：emb.f32（packed float32 LE）+ emb-ids.txt（id 顺序对齐）+ emb-meta.json（revision）。
 * dim 自适应：首写定维，读时按 文件字节数/id 数 推导。
 * 与 Rust memlite vectors.rs 文件格式互通（compat.md §三）；emb-meta.json 是 JS 侧新增的
 * 并发校验元数据，不影响 Rust 读取旧的两文件。
 *
 * 并发协议（concurrency-proposal.md §3.6）：
 * - 写入持向量排他锁，锁内重载两个数据文件与维度，校验目标记录 revision 后再落盘。
 * - 读取持向量共享锁加载同一代次，释放后用不可变缓存计算。
 * - 崩溃可能留下多余 f32 槽位；下次写入在锁内截断，读取忽略尾部并按 VECTOR_CORRUPT 报告错位。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ConcurrencyError,
  LockManager,
  type ConcurrencyConfig,
} from './lock'

export const VECTOR_F32 = 'emb.f32'
export const VECTOR_IDS = 'emb-ids.txt'
export const VECTOR_META = 'emb-meta.json'

export class VectorCorruptError extends Error {
  readonly code = 'VECTOR_CORRUPT'
  readonly dataDir: string

  constructor(dataDir: string, message: string) {
    super(`向量文件不一致：${message}`)
    this.name = 'VectorCorruptError'
    this.dataDir = dataDir
  }
}

export interface VectorOptions {
  concurrency?: ConcurrencyConfig
  logger?: { warn(msg: string): void }
  nativeLock?: boolean
}

export interface VectorPutOptions {
  /** 嵌入时对应的记忆 revision；锁内由 validate 取当前值，不一致则不写。 */
  revision?: number
  /** 在向量锁内调用；返回目标记录当前 revision，undefined 表示已删除。 */
  validate?: () => number | undefined
}

/** 同一向量代次的只读视图；Buffer 在锁释放后不再被原地修改。 */
export interface VectorSnapshot {
  readonly generation: string
  get(rid: string): number[] | undefined
  has(rid: string): boolean
  revisionOf(rid: string): number | undefined
  count(): number
}

export class VectorIndex {
  private readonly dir: string
  dim: number | undefined
  private readonly lock: LockManager
  private ids: string[] = []
  private offset = new Map<string, number>()
  private revisions = new Map<string, number>()
  private cache: Buffer | undefined
  private loadedGeneration = ''
  private trailingSlots = 0

  constructor(dir: string, options: VectorOptions = {}) {
    this.dir = dir
    this.lock = new LockManager({
      dataDir: dir,
      concurrency: options.concurrency,
      logger: options.logger,
      native: options.nativeLock,
    })
    this.lock.withLock(
      'vector',
      'shared',
      'vector.open',
      () => {
        this.loadLocked()
        this.loadedGeneration = this.computeSignatureLocked()
      },
      { createDir: false },
    )
  }

  private f32Path(): string {
    return path.join(this.dir, VECTOR_F32)
  }

  private idsPath(): string {
    return path.join(this.dir, VECTOR_IDS)
  }

  private metaPath(): string {
    return path.join(this.dir, VECTOR_META)
  }

  private computeSignatureLocked(): string {
    const parts: string[] = []
    for (const p of [this.idsPath(), this.f32Path(), this.metaPath()]) {
      try {
        const stat = fs.statSync(p, { bigint: true })
        parts.push(`${path.basename(p)}:${stat.size}:${stat.mtimeNs}:${stat.ino}`)
      } catch {
        parts.push(`${path.basename(p)}:missing`)
      }
    }
    return parts.join('|')
  }

  private refreshLocked(): void {
    const signature = this.computeSignatureLocked()
    if (signature === this.loadedGeneration) return
    this.loadLocked()
    this.loadedGeneration = signature
  }

  private loadLocked(): void {
    this.ids = []
    this.offset = new Map()
    this.revisions = new Map()
    this.cache = undefined
    this.trailingSlots = 0
    this.dim = undefined
    let text: string | undefined
    try {
      text = fs.readFileSync(this.idsPath(), 'utf8')
    } catch {
      text = undefined
    }
    if (text !== undefined) {
      for (const [i, line] of text.split('\n').entries()) {
        if (line === '') continue
        if (this.offset.has(line)) {
          throw new VectorCorruptError(this.dir, `emb-ids.txt 重复 id: ${line}`)
        }
        this.offset.set(line, i)
        this.ids.push(line)
      }
    }
    if (this.ids.length > 0) {
      let bytes = 0
      try {
        bytes = fs.statSync(this.f32Path()).size
      } catch {
        throw new VectorCorruptError(this.dir, '有 emb-ids.txt 但缺少 emb.f32')
      }
      if (bytes % 4 !== 0) {
        throw new VectorCorruptError(this.dir, `emb.f32 字节数不是 4 的倍数: ${bytes}`)
      }
      const floats = bytes / 4
      if (floats < this.ids.length) {
        throw new VectorCorruptError(
          this.dir,
          `emb.f32 槽位不足：${floats} < id 数 ${this.ids.length}`,
        )
      }
      if (floats % this.ids.length !== 0) {
        throw new VectorCorruptError(
          this.dir,
          `emb.f32 槽位数 ${floats} 不能被 id 数 ${this.ids.length} 整除`,
        )
      }
      const dim = floats / this.ids.length
      if (!Number.isSafeInteger(dim) || dim <= 0) {
        throw new VectorCorruptError(this.dir, `推导出的向量维度非法: ${dim}`)
      }
      this.dim = dim
      const expected = this.ids.length * dim * 4
      if (bytes > expected) this.trailingSlots = (bytes - expected) / 4
    }
    this.loadMetaLocked()
    try {
      this.cache = fs.readFileSync(this.f32Path())
    } catch {
      this.cache = undefined
    }
  }

  private loadMetaLocked(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.metaPath(), 'utf8'))
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const o = parsed as Record<string, unknown>
    const dim = o['dim']
    if (typeof dim === 'number' && Number.isSafeInteger(dim) && dim > 0) {
      if (this.dim !== undefined && this.dim !== dim) {
        throw new VectorCorruptError(this.dir, `emb-meta.json 维度 ${dim} 与文件推导 ${this.dim} 不符`)
      }
      this.dim = dim
    }
    const revisions = o['revisions']
    if (revisions && typeof revisions === 'object' && !Array.isArray(revisions)) {
      for (const [id, rev] of Object.entries(revisions)) {
        if (typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0) {
          this.revisions.set(id, rev)
        }
      }
    }
  }

  /** 只读快照：共享锁内加载，锁释放后使用不可变 Buffer。 */
  snapshot(operation = 'vector.snapshot'): VectorSnapshot {
    return this.lock.withLock(
      'vector',
      'shared',
      operation,
      () => {
        this.refreshLocked()
        const dim = this.dim
        const ids = this.ids
        const offset = new Map(this.offset)
        const revisions = new Map(this.revisions)
        const cache = this.cache
        const generation = this.loadedGeneration
        return {
          generation,
          count: () => ids.length,
          has: (rid: string) => offset.has(rid),
          revisionOf: (rid: string) => revisions.get(rid),
          get: (rid: string) => readVector(cache, offset.get(rid), dim),
        }
      },
      { createDir: false },
    )
  }

  get(rid: string): number[] | undefined {
    return this.snapshot('vector.get').get(rid)
  }

  revisionOf(rid: string): number | undefined {
    return this.snapshot('vector.revision').revisionOf(rid)
  }

  /**
   * 写入向量：向量排他锁内重载两文件，校验 revision 未过期后写入并 fsync。
   * 返回 false 表示目标记录已删除或版本已变，未写入（由后续 reembed 补齐）。
   */
  put(rid: string, emb: ArrayLike<number>, options: VectorPutOptions = {}): boolean {
    return this.lock.withLock(
      'vector',
      'exclusive',
      'vector.put',
      () => {
        this.refreshLocked()
        if (options.validate) {
          const current = options.validate()
          if (current === undefined) return false
          if (options.revision !== undefined && current !== options.revision) return false
        }
        if (emb.length === 0) throw new Error('向量为空')
        if (this.dim === undefined) this.dim = emb.length
        if (emb.length !== this.dim) {
          throw new Error(`向量维度不一致: ${emb.length} != ${this.dim}`)
        }
        fs.mkdirSync(this.dir, { recursive: true })
        this.truncateTrailingLocked()
        const buf = Buffer.alloc(emb.length * 4)
        for (let i = 0; i < emb.length; i++) buf.writeFloatLE(emb[i], i * 4)
        const existing = this.offset.get(rid)
        if (existing !== undefined) {
          const fd = fs.openSync(this.f32Path(), 'r+')
          try {
            fs.writeSync(fd, buf, 0, buf.length, existing * emb.length * 4)
            fs.fsyncSync(fd)
          } finally {
            fs.closeSync(fd)
          }
        } else {
          const dataFd = fs.openSync(this.f32Path(), 'a')
          try {
            fs.writeSync(dataFd, buf)
            fs.fsyncSync(dataFd)
          } finally {
            fs.closeSync(dataFd)
          }
          const idsFd = fs.openSync(this.idsPath(), 'a')
          try {
            fs.writeSync(idsFd, rid + '\n')
            fs.fsyncSync(idsFd)
          } finally {
            fs.closeSync(idsFd)
          }
          this.offset.set(rid, this.ids.length)
          this.ids.push(rid)
        }
        if (options.revision !== undefined) this.revisions.set(rid, options.revision)
        else this.revisions.delete(rid)
        this.writeMetaLocked()
        this.cache = undefined
        this.trailingSlots = 0
        // 强制下一次 snapshot 重读文件：否则内存 cache 已失效而代次签名仍是新的。
        this.loadedGeneration = ''
        return true
      },
    )
  }

  /** 崩溃残留的多余 f32 槽位：只在新追加前截断，避免影响已有 id 的偏移。 */
  private truncateTrailingLocked(): void {
    if (this.trailingSlots <= 0 || this.dim === undefined) return
    const expected = this.ids.length * this.dim * 4
    const fd = fs.openSync(this.f32Path(), 'r+')
    try {
      fs.ftruncateSync(fd, expected)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    this.trailingSlots = 0
    this.cache = undefined
  }

  private writeMetaLocked(): void {
    const revisions: Record<string, number> = {}
    for (const [id, rev] of this.revisions) revisions[id] = rev
    const value = { version: 1, dim: this.dim ?? 0, revisions }
    atomicWriteJson(this.metaPath(), value)
  }

  has(rid: string): boolean {
    return this.snapshot('vector.has').has(rid)
  }

  count(): number {
    return this.snapshot('vector.count').count()
  }

  /** 当前是否检测到崩溃残留尾部（状态展示用）。 */
  trailing(): number {
    return this.lock.withLock(
      'vector',
      'shared',
      'vector.trailing',
      () => {
        this.refreshLocked()
        return this.trailingSlots
      },
      { createDir: false },
    )
  }

  status(): Record<string, unknown> {
    return this.lock.withLock(
      'vector',
      'shared',
      'vector.status',
      () => {
        this.refreshLocked()
        return {
          count: this.ids.length,
          dim: this.dim ?? null,
          trailing_slots: this.trailingSlots,
          revisioned: this.revisions.size,
          generation: this.loadedGeneration,
        }
      },
      { createDir: false },
    )
  }
}

function readVector(
  cache: Buffer | undefined,
  idx: number | undefined,
  dim: number | undefined,
): number[] | undefined {
  if (cache === undefined || idx === undefined || dim === undefined) return undefined
  const start = idx * dim * 4
  const end = start + dim * 4
  if (end > cache.length) return undefined
  const out = new Array<number>(dim)
  for (let i = 0; i < dim; i++) out[i] = cache.readFloatLE(start + i * 4)
  return out
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
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    // 目录 fsync 在部分平台不支持
  }
}

/** 兼容旧调用：向量损坏时由调用方决定回退 BM25。 */
export { ConcurrencyError }

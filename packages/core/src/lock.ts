/**
 * 协作式跨进程文件锁（并发方案 §3.1–§3.2）。
 *
 * - 数据锁：共享读 / 排他写；向量锁与日志锁：排他。
 * - 优先使用 OS 原生整文件锁（fs-ext 的 flock）；描述符关闭即释放，
 *   不靠删除锁文件或 PID 判活，进程被终止也不会留下死锁。
 * - 未安装原生锁时，single-writer 降级为进程内锁并在状态中明示；
 *   multi-process 与 NFS 模式直接报 LOCK_UNSUPPORTED，不静默退回无锁写。
 * - 同进程内禁止重入、嵌套与锁升级；固定顺序：数据锁 → 向量锁。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

export const DATA_LOCK = '.memlite-data.lock'
export const VECTOR_LOCK = '.memlite-vector.lock'
export const LOG_LOCK = '.memlite-log.lock'

export type ConcurrencyMode = 'single-writer' | 'multi-process'
export type FilesystemMode = 'auto' | 'local' | 'nfs'
export type LockBackend = 'flock' | 'in-process'
export type LockKind = 'data' | 'vector' | 'log'
export type LockMode = 'shared' | 'exclusive'

/** 并发配置（config.json 的 concurrency 段；TS API 用 camelCase，文件用 snake_case）。 */
export interface ConcurrencyConfig {
  mode?: ConcurrencyMode
  filesystem?: FilesystemMode
  lockTimeoutMs?: number
}

export interface ResolvedConcurrency {
  mode: ConcurrencyMode
  filesystem: FilesystemMode
  lockTimeoutMs: number
}

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000
export const MIN_LOCK_TIMEOUT_MS = 100
export const MAX_LOCK_TIMEOUT_MS = 120_000

/** 统一并发错误：只带数据目录/操作/是否已提交与建议，不带记忆正文或凭据。 */
export class ConcurrencyError extends Error {
  readonly code: string
  readonly dataDir: string
  readonly operation: string
  readonly committed: boolean
  readonly advice: string

  constructor(
    code: string,
    message: string,
    opts: { dataDir: string; operation: string; committed?: boolean; advice?: string },
  ) {
    super(message)
    this.name = 'ConcurrencyError'
    this.code = code
    this.dataDir = opts.dataDir
    this.operation = opts.operation
    this.committed = opts.committed ?? false
    this.advice = opts.advice ?? '关闭其他写者或稍后重试'
  }
}

export class LockTimeoutError extends ConcurrencyError {
  constructor(dataDir: string, operation: string, timeoutMs: number) {
    super('LOCK_TIMEOUT', `等待文件锁超时（${timeoutMs}ms）: ${operation}`, {
      dataDir,
      operation,
      advice: '关闭占用该数据目录的其他实例，或增大 concurrency.lock_timeout_ms',
    })
    this.name = 'LockTimeoutError'
  }
}

export class LockUnsupportedError extends ConcurrencyError {
  constructor(dataDir: string, operation: string, reason: string) {
    super('LOCK_UNSUPPORTED', `文件锁不可用: ${reason}`, {
      dataDir,
      operation,
      advice: '安装可选 peer 依赖 fs-ext（pnpm add fs-ext；需本机编译工具）后重新加载，或退回 single-writer 并确保只有一个写者',
    })
    this.name = 'LockUnsupportedError'
  }
}

export class SnapshotChangedError extends ConcurrencyError {
  constructor(dataDir: string, operation: string) {
    super('SNAPSHOT_CHANGED', '同步期间数据代次已变化，已中止以重取快照', {
      dataDir,
      operation,
      advice: '重新执行 sync；不要手工合并未审核的并发新增',
    })
    this.name = 'SnapshotChangedError'
  }
}

interface FsExt {
  flockSync(fd: number, flags: string): void
}

let fsExtCache: FsExt | null | undefined

/** 动态加载可选原生依赖；未安装/构建失败返回 null（不抛启动错误）。 */
export function loadFsExt(): FsExt | null {
  if (fsExtCache !== undefined) return fsExtCache
  try {
    // ESM 用 import.meta.url；CJS 构建由 tsup 把 import.meta.url 定义为 __filename
    const req = createRequire(import.meta.url)
    fsExtCache = req('fs-ext') as FsExt
  } catch {
    fsExtCache = null
  }
  return fsExtCache
}

/** 测试用：清空原生锁探测缓存。 */
export function resetFsExtCache(): void {
  fsExtCache = undefined
}

function isWouldBlock(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EACCES'
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms)
}

/** 当前进程持有的锁（同一 LockManager 实例内防重入）。 */
interface HeldLock {
  mode: LockMode
  operation: string
}

export interface LockManagerOptions {
  dataDir: string
  concurrency?: ConcurrencyConfig
  logger?: { warn(msg: string): void }
  /** 测试/宿主可强制禁用原生锁（不改变生产默认） */
  native?: boolean
}

export class LockManager {
  readonly dataDir: string
  readonly concurrency: ResolvedConcurrency
  readonly backend: LockBackend
  private readonly native: FsExt | null
  private readonly held = new Map<string, HeldLock>()
  private readonly logger: { warn(msg: string): void }

  constructor(opts: LockManagerOptions) {
    this.dataDir = opts.dataDir
    this.concurrency = resolveConcurrency(opts.concurrency)
    this.logger = opts.logger ?? { warn: () => {} }
    const canNative = opts.native !== false && loadFsExt() !== null
    this.native = canNative ? loadFsExt() : null
    if (!this.native) {
      if (this.concurrency.mode === 'multi-process') {
        throw new LockUnsupportedError(this.dataDir, 'open', 'multi-process 需要原生文件锁 fs-ext')
      }
      if (this.concurrency.filesystem === 'nfs') {
        throw new LockUnsupportedError(this.dataDir, 'open', 'NFS 模式需要原生文件锁')
      }
      this.backend = 'in-process'
    } else {
      this.backend = 'flock'
    }
  }

  lockPath(kind: LockKind): string {
    if (kind === 'data') return path.join(this.dataDir, DATA_LOCK)
    if (kind === 'vector') return path.join(this.dataDir, VECTOR_LOCK)
    return path.join(this.dataDir, LOG_LOCK)
  }

  /** 数据目录还不存在时，读路径不需要创建目录与锁文件。 */
  private lockFileUsable(createDir: boolean): boolean {
    if (fs.existsSync(this.dataDir)) return true
    if (!createDir) return false
    fs.mkdirSync(this.dataDir, { recursive: true })
    return true
  }

  /** 在指定锁内执行同步函数；fn 内不得再获取同路径锁（重入直接报错）。 */
  withLock<T>(
    kind: LockKind,
    mode: LockMode,
    operation: string,
    fn: () => T,
    opts: { createDir?: boolean } = {},
  ): T {
    const createDir = opts.createDir ?? mode === 'exclusive'
    if (!this.lockFileUsable(createDir)) return fn()
    const lockPath = this.lockPath(kind)
    const held = this.held.get(lockPath)
    if (held) {
      throw new ConcurrencyError('LOCK_REENTRANT', `不可重入的文件锁: ${operation}`, {
        dataDir: this.dataDir,
        operation,
        advice: '检查公开入口是否嵌套持锁；内部只调用未加锁原语',
      })
    }
    if (kind === 'data' && this.held.size > 0) {
      throw new ConcurrencyError('LOCK_ORDER', '固定锁顺序：数据锁必须在向量/日志锁之前', {
        dataDir: this.dataDir,
        operation,
      })
    }
    const handle = this.acquire(lockPath, mode, operation)
    this.held.set(lockPath, { mode, operation })
    try {
      return fn()
    } finally {
      this.held.delete(lockPath)
      handle()
    }
  }

  private acquire(lockPath: string, mode: LockMode, operation: string): () => void {
    if (this.backend === 'in-process') {
      return () => {}
    }
    const native = this.native!
    let fd: number
    try {
      fd = fs.openSync(lockPath, 'a+')
    } catch (e) {
      throw new ConcurrencyError('LOCK_UNSUPPORTED', `无法打开锁文件: ${String(e)}`, {
        dataDir: this.dataDir,
        operation,
      })
    }
    const deadline = Date.now() + this.concurrency.lockTimeoutMs
    const flag = mode === 'shared' ? 'shnb' : 'exnb'
    for (;;) {
      try {
        native.flockSync(fd, flag)
        return () => fs.closeSync(fd)
      } catch (e) {
        if (!isWouldBlock(e)) {
          try {
            fs.closeSync(fd)
          } catch {
            // 关闭失败也不掩盖原始错误
          }
          const code = (e as { code?: string } | null)?.code ?? 'UNKNOWN'
          throw new ConcurrencyError('LOCK_UNSUPPORTED', `获取文件锁失败（${code}）: ${operation}`, {
            dataDir: this.dataDir,
            operation,
            advice: '检查文件系统是否支持锁、目录权限是否足够',
          })
        }
        const left = deadline - Date.now()
        if (left <= 0) {
          try {
            fs.closeSync(fd)
          } catch {
            // 同上
          }
          throw new LockTimeoutError(this.dataDir, operation, this.concurrency.lockTimeoutMs)
        }
        sleepSync(Math.min(10, left))
      }
    }
  }

  /** 锁协议是否具备跨进程保证 */
  get crossProcess(): boolean {
    return this.backend !== 'in-process'
  }

  /** 启动时的可诊断提示：降级路径只警告一次，不阻拦 single-writer。 */
  warnIfDegraded(): void {
    if (this.backend === 'in-process') {
      this.logger.warn(
        '原生文件锁 fs-ext 未安装（可选 peer）：single-writer 使用进程内锁；多进程或 NFS 模式会被拒绝；需要时 pnpm add fs-ext',
      )
    }
  }
}

/** 合并配置并做范围校验；非法值快速失败。 */
export function resolveConcurrency(cfg?: ConcurrencyConfig): ResolvedConcurrency {
  const mode = cfg?.mode ?? 'single-writer'
  if (mode !== 'single-writer' && mode !== 'multi-process') {
    throw new Error(`concurrency.mode 非法: ${String(mode)}（single-writer | multi-process）`)
  }
  const filesystem = cfg?.filesystem ?? 'local'
  if (filesystem !== 'auto' && filesystem !== 'local' && filesystem !== 'nfs') {
    throw new Error(`concurrency.filesystem 非法: ${String(filesystem)}（auto | local | nfs）`)
  }
  const timeout = cfg?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_LOCK_TIMEOUT_MS ||
    timeout > MAX_LOCK_TIMEOUT_MS
  ) {
    throw new Error(
      `concurrency.lock_timeout_ms 须为 ${MIN_LOCK_TIMEOUT_MS}..${MAX_LOCK_TIMEOUT_MS} 的整数`,
    )
  }
  return { mode, filesystem, lockTimeoutMs: timeout }
}

export interface FilesystemInfo {
  kind: 'local' | 'network' | 'unknown'
  type: string
  mount: string
}

const NETWORK_TYPES = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smbfs',
  'smb3',
  'sshfs',
  'fuse.sshfs',
  'autofs',
  'webdav',
  'davfs',
  '9p',
  'ceph',
  'glusterfs',
])

/** 识别数据目录所在文件系统；只用于拒绝未声明的网络目录，探测失败按 unknown 放行。 */
export function detectFilesystem(dir: string): FilesystemInfo {
  try {
    const abs = path.resolve(dir)
    if (process.platform === 'linux') return detectLinuxMount(abs)
    if (process.platform === 'darwin') return detectDarwinMount(abs)
  } catch {
    // 探测失败不影响本地模式
  }
  return { kind: 'unknown', type: '', mount: '' }
}

function mountPrefixMatch(abs: string, mountPoint: string): boolean {
  if (mountPoint === '/') return true
  return abs === mountPoint || abs.startsWith(mountPoint.replace(/\/+$/, '') + '/')
}

function detectLinuxMount(abs: string): FilesystemInfo {
  const text = fs.readFileSync('/proc/self/mountinfo', 'utf8')
  let best: { mount: string; type: string } | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split(' ')
    const sep = parts.indexOf('-')
    if (sep < 0 || parts.length < sep + 2) continue
    const mount = unescapeMount(parts[4] ?? '')
    const type = parts[sep + 1] ?? ''
    if (!mountPrefixMatch(abs, mount)) continue
    if (!best || mount.length > best.mount.length) best = { mount, type }
  }
  if (!best) return { kind: 'unknown', type: '', mount: '' }
  return { kind: NETWORK_TYPES.has(best.type) ? 'network' : 'local', ...best }
}

function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

function detectDarwinMount(abs: string): FilesystemInfo {
  let out = ''
  try {
    out = execFileSync('mount', [], { encoding: 'utf8' })
  } catch {
    return { kind: 'unknown', type: '', mount: '' }
  }
  let best: { mount: string; type: string; local: boolean } | undefined
  for (const line of out.split('\n')) {
    // 例：/dev/disk3s1 on / (apfs, local, journaled)
    const m = /^(.+?) on (.+?) \(([^)]*)\)\s*$/.exec(line)
    if (!m) continue
    const mount = m[2]
    const opts = m[3].split(',').map((s) => s.trim())
    const type = opts[0] ?? ''
    const local = opts.includes('local')
    if (!mountPrefixMatch(abs, mount)) continue
    if (!best || mount.length > best.mount.length) best = { mount, type, local }
  }
  if (!best) return { kind: 'unknown', type: '', mount: '' }
  const network = NETWORK_TYPES.has(best.type) || (!best.local && best.type !== 'apfs')
  return { kind: network ? 'network' : 'local', type: best.type, mount: best.mount }
}

export interface NfsProbeResult {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; detail?: string }>
  at: number
}

const probeCache = new Map<string, NfsProbeResult>()

/**
 * NFS 受控读写探针：只在隔离临时文件上做锁/可见性/rename/fsync 检查，
 * 不碰真实记忆。失败即拒绝把该挂载用于共享写入。
 */
export function probeNfs(dir: string, timeoutMs = 2_000): NfsProbeResult {
  const cached = probeCache.get(dir)
  if (cached) return cached
  const checks: NfsProbeResult['checks'] = []
  const put = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
  }
  const native = loadFsExt()
  if (!native) {
    const result = { ok: false, checks: [{ name: 'native-lock', ok: false, detail: 'fs-ext 不可用' }], at: Date.now() }
    probeCache.set(dir, result)
    return result
  }
  const tag = `${process.pid}-${Math.random().toString(36).slice(2)}`
  const a = path.join(dir, `.memlite-probe-${tag}.a`)
  const b = path.join(dir, `.memlite-probe-${tag}.b`)
  const fds: number[] = []
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(a, 'probe\n')
    const fd1 = fs.openSync(a, 'a+')
    fds.push(fd1)
    native.flockSync(fd1, 'exnb')
    put('exclusive-lock', true)
    const fd2 = fs.openSync(a, 'a+')
    fds.push(fd2)
    let blocked = false
    try {
      native.flockSync(fd2, 'exnb')
    } catch (e) {
      blocked = isWouldBlock(e)
    }
    put('exclusive-conflict', blocked)
    fs.closeSync(fd2)
    fds.pop()
    fs.closeSync(fd1)
    fds.pop()
    // 共享锁可并发；共享期间排他锁应被拒绝
    const s1 = fs.openSync(a, 'a+')
    const s2 = fs.openSync(a, 'a+')
    fds.push(s1, s2)
    native.flockSync(s1, 'shnb')
    native.flockSync(s2, 'shnb')
    put('shared-lock', true)
    const ex = fs.openSync(a, 'a+')
    fds.push(ex)
    let sharedBlocksExclusive = false
    try {
      native.flockSync(ex, 'exnb')
    } catch (e) {
      sharedBlocksExclusive = isWouldBlock(e)
    }
    put('shared-blocks-exclusive', sharedBlocksExclusive)
    for (const fd of [s1, s2, ex]) {
      fs.closeSync(fd)
      fds.splice(fds.indexOf(fd), 1)
    }
    // 写后读 + rename + fsync
    fs.appendFileSync(a, 'visible\n')
    put('write-read', fs.readFileSync(a, 'utf8').includes('visible'))
    const syncFd = fs.openSync(a, 'r+')
    try {
      fs.fsyncSync(syncFd)
    } finally {
      fs.closeSync(syncFd)
    }
    fs.renameSync(a, b)
    put('atomic-rename', fs.existsSync(b))
    put('read-after-rename', fs.readFileSync(b, 'utf8').includes('visible'))
  } catch (e) {
    put('probe', false, e instanceof Error ? e.message : String(e))
  } finally {
    for (const fd of fds) {
      try {
        fs.closeSync(fd)
      } catch {
        // 探针清理失败只记录
      }
    }
    for (const p of [a, b]) {
      try {
        fs.rmSync(p, { force: true })
      } catch {
        // 同上
      }
    }
  }
  const result: NfsProbeResult = { ok: checks.length > 0 && checks.every((c) => c.ok), checks, at: Date.now() }
  probeCache.set(dir, result)
  void timeoutMs
  return result
}

/** 测试用：清空探针缓存。 */
export function resetNfsProbeCache(): void {
  probeCache.clear()
}

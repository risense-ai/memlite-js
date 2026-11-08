/**
 * 同步层：git 同步（数据仓本身，或工作区仓——项目级记忆文件夹随外层仓走）。
 * 白名单 glob（memory*.jsonl/meta.json/README.md）+ push 后双通道核验 sha。
 * 向量文件（emb.f32/emb-ids.txt）不在白名单——本机可重算（reembed），不入 git。
 */
import { execFile, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import {
  LockManager,
  SnapshotChangedError,
  type ConcurrencyConfig,
} from './lock'

const execFileP = promisify(execFile)

/** 锁内 add：git 只读工作区文件，必须在数据共享锁内冻结 index。 */
function gitSync(repo: string, args: string[]): void {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string }
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? ''
    throw new Error(`git ${args.join(' ')} 失败: ${stderr.trim() || err.message || String(e)}`)
  }
}

export interface SyncOptions {
  concurrency?: ConcurrencyConfig
  logger?: { warn(msg: string): void }
}

async function git(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['-C', repo, ...args])
    return stdout.trim()
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string }
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? ''
    throw new Error(`git ${args.join(' ')} 失败: ${stderr.trim() || err.message || String(e)}`)
  }
}

async function hasRemote(repo: string): Promise<boolean> {
  try {
    const s = await git(repo, ['remote', 'get-url', 'origin'])
    return s !== ''
  } catch {
    return false
  }
}

/** 展开白名单：data_dir 下真实存在的文件（git pathspec 无匹配会报错） */
export function whitelisted(dataDir: string): string[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(dataDir)
  } catch {
    return []
  }
  const out = names.filter(
    (name) =>
      (name.startsWith('memory') && name.endsWith('.jsonl')) ||
      name === 'meta.json' ||
      name === 'README.md',
  )
  out.sort()
  return out
}

/** 找 data_dir 之上的 git 仓根：自身是仓 → 用它；否则向上找 .git（项目级记忆随工作区仓同步） */
export function findRepo(dataDir: string): string | undefined {
  if (fs.existsSync(path.join(dataDir, '.git'))) return dataDir
  let cur = dataDir
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) return undefined
    cur = parent
    if (fs.existsSync(path.join(cur, '.git'))) return cur
  }
}

export interface SyncStatus {
  data_dir: string
  repo: string | null
  has_remote: boolean
  dirty: boolean
  local_sha: string
  note?: string
}

export async function status(dataDir: string): Promise<SyncStatus> {
  const repo = findRepo(dataDir)
  if (!repo) {
    return {
      data_dir: dataDir,
      repo: null,
      has_remote: false,
      dirty: false,
      local_sha: '',
      note: '不在任何 git 仓内（项目级记忆须在 git 工作区内，或 git init 数据仓）',
    }
  }
  const remote = await hasRemote(repo)
  // data_dir 相对仓库根的前缀（仓本身时为空）
  const prefix = path.relative(repo, dataDir)
  const files = whitelisted(dataDir)
  let dirty = false
  for (const f of files) {
    const rel = prefix ? path.join(prefix, f) : f
    const out = await git(repo, ['status', '--porcelain', '--', rel]).catch(() => '')
    if (out !== '') {
      dirty = true
      break
    }
  }
  let head = ''
  try {
    head = await git(repo, ['rev-parse', 'HEAD'])
  } catch {
    head = ''
  }
  return {
    data_dir: dataDir,
    repo,
    has_remote: remote,
    dirty,
    local_sha: head,
  }
}

export interface SyncReport {
  committed: boolean
  local_sha: string
  remote_sha: string
  verified: boolean
  /** 实际同步的仓库根（调试/展示用） */
  repo: string
}

/** 一次完整同步。data_dir 可以是仓本身或仓内子目录（项目级记忆文件夹）——
 * 白名单文件在 data_dir 下找，git 操作在仓库根做，add 用相对仓库根的路径。
 * add 在数据共享锁内冻结 index；release 后才 commit/rebase/push，期间新增写入不混入本次提交。 */
export async function sync(dataDir: string, options: SyncOptions = {}): Promise<SyncReport> {
  const repo = findRepo(dataDir)
  if (!repo) {
    throw new Error(`${dataDir} 及其上层目录都不是 git 仓；先 git init 或 git clone`)
  }
  if (!(await hasRemote(repo))) {
    throw new Error(
      '未配置 origin；先 git remote add origin <私有仓URL>（项目级可省——工作区仓已有 remote 则直接用）',
    )
  }
  const prefix = path.relative(repo, dataDir)
  const lock = new LockManager({
    dataDir,
    concurrency: options.concurrency,
    logger: options.logger,
  })

  // 1. 数据共享锁内只 add 白名单（仓根视角的相对路径）；index 即本次同步的时点快照
  let files = whitelisted(dataDir)
  let addPaths = files.map((f) => (prefix ? path.join(prefix, f) : f))
  let generation = snapshotGeneration(dataDir)
  if (addPaths.length > 0) {
    lock.withLock(
      'data',
      'shared',
      'sync.add',
      () => gitSync(repo, ['add', '--', ...addPaths]),
      { createDir: false },
    )
  }

  // 2. add 后、commit 前若代次已变，重取一次快照；再变则明确中止，不把未审核新增混入
  const afterAdd = snapshotGeneration(dataDir)
  if (afterAdd !== generation) {
    files = whitelisted(dataDir)
    addPaths = files.map((f) => (prefix ? path.join(prefix, f) : f))
    generation = afterAdd
    if (addPaths.length > 0) {
      lock.withLock(
        'data',
        'shared',
        'sync.refresh',
        () => gitSync(repo, ['add', '--', ...addPaths]),
        { createDir: false },
      )
    }
    if (snapshotGeneration(dataDir) !== generation) {
      throw new SnapshotChangedError(dataDir, 'sync')
    }
  }

  // 2. 只提交白名单文件——commit 必须带路径限定！否则会把工作区里
  //    用户已暂存的无关改动一并卷进 memlite 的同步提交。
  //    用 `git diff --cached --quiet -- <paths>` 判「白名单自身有无变更」。
  let committed = false
  if (addPaths.length > 0) {
    const staged = await execFileP('git', ['-C', repo, 'diff', '--cached', '--quiet', '--', ...addPaths])
      .then(() => true)
      .catch(() => false)
    committed = !staged
    if (committed) {
      const msg = `memlite sync ${chronoLite()}`
      await git(repo, ['commit', '-m', msg, '--', ...addPaths])
    }
  }

  // 3. fetch；远端分支已存在才 rebase（首推时远端可能为空仓）
  await git(repo, ['fetch', 'origin'])
  const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const remoteRef = await git(repo, ['ls-remote', '--heads', 'origin', branch]).catch(() => '')
  if (remoteRef !== '') {
    // --autostash：工作区有用户未提交/已暂存改动时先 stash 再 rebase、完事还原——
    // 否则项目级记忆随工作区仓同步会被用户手头的半成品卡死
    await git(repo, ['pull', '--rebase', '--autostash', 'origin', branch])
  }

  // 4. push -u
  await git(repo, ['push', '-u', 'origin', branch])

  // 5. 双通道核验
  const localSha = await git(repo, ['rev-parse', 'HEAD'])
  const ls = await git(repo, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const remoteSha = ls.split(/\s+/)[0] ?? ''
  const verified = remoteSha !== '' && localSha === remoteSha
  if (!verified) {
    throw new Error(
      `push 核验失败: local=${localSha.slice(0, 8)} remote=${remoteSha.slice(0, 8)}`,
    )
  }
  return { committed, local_sha: localSha, remote_sha: remoteSha, verified, repo }
}

/** 白名单数据的稳定代次（文件名+size+mtime+inode）；锁文件/向量/日志不入。 */
function snapshotGeneration(dataDir: string): string {
  const parts: string[] = []
  let names: string[] = []
  try {
    names = fs.readdirSync(dataDir)
  } catch {
    return ''
  }
  for (const name of names.sort()) {
    if (!/^memory-\d+\.jsonl$/.test(name) && name !== 'memory.jsonl' && name !== 'meta.json') {
      continue
    }
    try {
      const stat = fs.statSync(path.join(dataDir, name), { bigint: true })
      parts.push(`${name}:${stat.size}:${stat.mtimeNs}:${stat.ino}`)
    } catch {
      parts.push(`${name}:missing`)
    }
  }
  return parts.join('|')
}

/** 本地时间格式化（避免引入 chrono 依赖） */
function chronoLite(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

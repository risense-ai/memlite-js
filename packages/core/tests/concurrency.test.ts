import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigCtx,
  ConcurrencyError,
  LockManager,
  LockTimeoutError,
  LockUnsupportedError,
  META_FILE,
  Memlite,
  STORAGE_PROTOCOL,
  Store,
  VectorCorruptError,
  VectorIndex,
  appendLine,
  concurrencyMerged,
  configSet,
  detectFilesystem,
  loadFsExt,
  probeNfs,
  recordRevision,
  resetNfsProbeCache,
  type Entry,
} from '../src/index'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORKER = path.join(HERE, 'fixtures', 'concurrency-worker.ts')
const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-conc-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

interface Worker {
  child: ChildProcess
  lines: Array<Record<string, unknown>>
  waitFor: (pred: (line: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  done: Promise<void>
  stderr: () => string
}

function worker(args: string[]): Worker {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: Array<Record<string, unknown>> = []
  let buffer = ''
  let stderr = ''
  const waiters: Array<{
    pred: (line: Record<string, unknown>) => boolean
    resolve: (line: Record<string, unknown>) => void
  }> = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx < 0) break
      const raw = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (raw === '') continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        lines.push(parsed)
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].pred(parsed)) {
            waiters[i].resolve(parsed)
            waiters.splice(i, 1)
          }
        }
      } catch {
        // 子进程可能打印非 JSON 诊断，保留到 stderr 供失败时排查
        stderr += raw + '\n'
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const done = new Promise<void>((resolve) => {
    child.on('close', () => resolve())
  })
  return {
    child,
    lines,
    done,
    stderr: () => stderr,
    waitFor: (pred, timeoutMs = 15_000) =>
      new Promise((resolve, reject) => {
        const existing = lines.find(pred)
        if (existing) return resolve(existing)
        const timer = setTimeout(() => {
          reject(new Error(`等待子进程输出超时；stderr=${stderr}`))
        }, timeoutMs)
        waiters.push({
          pred,
          resolve: (line) => {
            clearTimeout(timer)
            resolve(line)
          },
        })
      }),
  }
}

function byKey(lines: Array<Record<string, unknown>>, key: string): unknown[] {
  return lines.filter((l) => l[key] !== undefined).map((l) => l[key])
}

const native = loadFsExt() !== null

describe.skipIf(!native)('跨进程文件锁（真实进程）', () => {
  it('排他锁互斥、有界超时、进程退出释放', async () => {
    const d = tmp()
    const holder = worker(['hold', d, '900'])
    await holder.waitFor((l) => l['locked'] === true)
    const lock = new LockManager({
      dataDir: d,
      concurrency: { mode: 'multi-process', lockTimeoutMs: 150 },
    })
    expect(() =>
      lock.withLock('data', 'exclusive', 'contend', () => undefined, { createDir: true }),
    ).toThrow(LockTimeoutError)
    await holder.done
    expect(holder.lines.some((l) => l['released'] === true)).toBe(true)
    lock.withLock('data', 'exclusive', 'after-release', () => undefined, { createDir: true })
  }, 30_000)

  it('持锁进程被杀死后锁自动释放', async () => {
    const d = tmp()
    const holder = worker(['crash-hold', d])
    await holder.waitFor((l) => l['locked'] === true)
    holder.child.kill('SIGKILL')
    await holder.done
    const lock = new LockManager({
      dataDir: d,
      concurrency: { mode: 'multi-process', lockTimeoutMs: 1_000 },
    })
    expect(() =>
      lock.withLock('data', 'exclusive', 'after-kill', () => undefined, { createDir: true }),
    ).not.toThrow()
  }, 30_000)

  it('锁重入与逆序获取快速失败', () => {
    const d = tmp()
    const lock = new LockManager({
      dataDir: d,
      concurrency: { mode: 'multi-process', lockTimeoutMs: 300 },
    })
    expect(() =>
      lock.withLock('data', 'exclusive', 'outer', () => {
        lock.withLock('data', 'shared', 'inner', () => undefined)
      }, { createDir: true }),
    ).toThrow(ConcurrencyError)
    expect(() =>
      lock.withLock('vector', 'exclusive', 'v', () => {
        lock.withLock('data', 'shared', 'd', () => undefined)
      }, { createDir: true }),
    ).toThrow(ConcurrencyError)
  })

  it('无原生锁时 multi-process 明确拒绝，single-writer 仅降级进程内锁', () => {
    const d = tmp()
    const s = new Store(d, undefined, { nativeLock: false })
    s.put('单写者', 't', [], '')
    expect(s.concurrencyStatus().lock_backend).toBe('in-process')
    expect(
      () => new Store(d, undefined, { nativeLock: false, concurrency: { mode: 'multi-process' } }),
    ).toThrow(LockUnsupportedError)
  })
})

describe.skipIf(!native)('级别 1：本地多进程读写', () => {
  it('8 个进程并发新增全部保留，无坏行', async () => {
    const d = tmp()
    const workers = Array.from({ length: 8 }, (_, i) => worker(['store-put', d, `p${i}`, '10']))
    await Promise.all(workers.map((w) => w.done))
    const ids = byKey(workers.flatMap((w) => w.lines), 'ids').flat() as string[]
    expect(ids).toHaveLength(80)
    expect(new Set(ids).size).toBe(80)
    const store = new Store(d, undefined, { concurrency: { mode: 'multi-process' } })
    const snap = store.snapshot()
    expect(snap.count()).toBe(80)
    expect(snap.badLines).toBe(0)
  }, 60_000)

  it('同显式 id 并发新增仅一个成功', async () => {
    const d = tmp()
    const id = 'sameid123456'
    const workers = [worker(['explicit-id', d, id]), worker(['explicit-id', d, id])]
    await Promise.all(workers.map((w) => w.done))
    const results = workers.flatMap((w) => w.lines).filter((l) => l['ok'] !== undefined)
    expect(results.filter((r) => r['ok'] === true)).toHaveLength(1)
    expect(results.filter((r) => r['ok'] === false)).toHaveLength(1)
    const store = new Store(d, undefined, { concurrency: { mode: 'multi-process' } })
    expect(store.count()).toBe(1)
  }, 30_000)

  it('同 revision 条件写仅一个成功，另一个 STALE_VERSION', async () => {
    const d = tmp()
    const mem = new Memlite({
      dataDir: d,
      sensitiveGate: false,
      concurrency: { mode: 'multi-process' },
    })
    mem.open()
    const id = await mem.remember('原正文', { title: '条件写' })
    const revision = recordRevision(mem.store.peek(id)!)
    const go = path.join(d, 'go')
    const workers = [
      worker(['conditional', d, id, String(revision), go, '窗口 A']),
      worker(['conditional', d, id, String(revision), go, '窗口 B']),
    ]
    await Promise.all(workers.map((w) => w.waitFor((l) => l['ready'] === true)))
    fs.writeFileSync(go, '1')
    await Promise.all(workers.map((w) => w.done))
    const results = workers.flatMap((w) => w.lines).filter((l) => l['ok'] !== undefined)
    expect(results.filter((r) => r['ok'] === true)).toHaveLength(1)
    const winner = results.find((r) => r['ok'] === true)
    const conflict = results.find((r) => r['ok'] === false)
    expect(conflict?.['code']).toBe('STALE_VERSION')
    const reopened = new Memlite({
      dataDir: d,
      sensitiveGate: false,
      concurrency: { mode: 'multi-process' },
    })
    reopened.open()
    expect(reopened.show(id)?.record.content).toBe(winner?.['content'])
  }, 30_000)

  it('压实/轮转与并发新增交错不丢记录', async () => {
    const d = tmp()
    const writer = worker(['write-loop', d, 'c', '60', '3'])
    const compactor = worker(['compact', d, '12'])
    await Promise.all([writer.done, compactor.done])
    const ids = (writer.lines.find((l) => l['ids'] !== undefined)?.['ids'] ?? []) as string[]
    expect(ids).toHaveLength(60)
    const store = new Store(d, undefined, { concurrency: { mode: 'multi-process' } })
    const snap = store.snapshot()
    expect(snap.count()).toBe(60)
    expect(snap.badLines).toBe(0)
    expect(new Set(snap.all().map((r) => r.id)).size).toBe(60)
  }, 60_000)

  it('读取快照在写入期间始终完整（无坏行）', async () => {
    const d = tmp()
    const writer = worker(['write-loop', d, 's', '50', '2'])
    const readers = [worker(['snapshot-read', d, '80']), worker(['snapshot-read', d, '80'])]
    await Promise.all([writer.done, ...readers.map((r) => r.done)])
    for (const r of readers) {
      expect(r.lines.some((l) => l['ok'] === true)).toBe(true)
      expect(r.lines.some((l) => l['ok'] === false)).toBe(false)
    }
    const store = new Store(d, undefined, { concurrency: { mode: 'multi-process' } })
    expect(store.snapshot().count()).toBe(50)
  }, 60_000)

  it('并发检索日志追加不破坏行', async () => {
    const d = tmp()
    const workers = Array.from({ length: 4 }, () => worker(['log-append', d, '40']))
    await Promise.all(workers.map((w) => w.done))
    const text = fs.readFileSync(path.join(d, 'memory.querylog.jsonl'), 'utf8')
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(160)
    for (const line of lines) {
      const e = JSON.parse(line) as Entry
      expect(typeof e.query).toBe('string')
    }
  }, 30_000)

  it('并发向量写入不串位，id/偏移/manifest 一致', async () => {
    const d = tmp()
    const workers = Array.from({ length: 4 }, (_, i) =>
      worker(['vector-put', d, `v${i}`, '6', '4']),
    )
    await Promise.all(workers.map((w) => w.done))
    const v = new VectorIndex(d, { concurrency: { mode: 'multi-process' } })
    expect(v.count()).toBe(24)
    expect(v.dim).toBe(4)
    const f32 = fs.readFileSync(path.join(d, 'emb.f32'))
    expect(f32.length).toBe(24 * 4 * 4)
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'emb-meta.json'), 'utf8')) as {
      revisions: Record<string, number>
    }
    expect(Object.keys(meta.revisions)).toHaveLength(24)
    expect(v.status()['trailing_slots']).toBe(0)
  }, 30_000)
})

describe('并发配置与文件系统探测', () => {
  it('configSet 校验并写入 concurrency 段；concurrencyMerged 读回', () => {
    const home = tmp()
    const ctx: ConfigCtx = { home, env: {}, cwd: home }
    configSet('concurrency.mode', 'multi-process', false, ctx)
    configSet('concurrency.filesystem', 'local', false, ctx)
    configSet('concurrency.lock_timeout_ms', '2500', false, ctx)
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, '.memlite', 'config.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(cfg['concurrency']).toEqual({
      mode: 'multi-process',
      filesystem: 'local',
      lock_timeout_ms: 2500,
    })
    expect(concurrencyMerged(ctx)).toEqual({
      mode: 'multi-process',
      filesystem: 'local',
      lockTimeoutMs: 2500,
    })
    expect(() => configSet('concurrency.mode', 'bogus', false, ctx)).toThrow('非法')
    expect(() => configSet('concurrency.lock_timeout_ms', '10', false, ctx)).toThrow('100')
  })

  it('首次写入标记 storage_protocol=1，旧库保持可读', () => {
    const d = tmp()
    const s = new Store(d, undefined, { concurrency: { mode: 'multi-process' } })
    expect(s.concurrencyStatus().storage_protocol).toBe(0)
    s.put('协议标记', 't', [], '')
    const meta = JSON.parse(fs.readFileSync(path.join(d, META_FILE), 'utf8')) as Record<string, unknown>
    expect(meta['storage_protocol']).toBe(STORAGE_PROTOCOL)
    expect(new Store(d, undefined, { concurrency: { mode: 'multi-process' } }).count()).toBe(1)
  })

  it('向量 revision 过期不写；文件错位报 VECTOR_CORRUPT', () => {
    const d = tmp()
    const v = new VectorIndex(d)
    expect(v.put('a', [1, 0], { revision: 0 })).toBe(true)
    expect(v.get('a')).toEqual([1, 0])
    expect(v.put('a', [0, 1], { revision: 0, validate: () => 1 })).toBe(false)
    expect(v.get('a')).toEqual([1, 0])
    expect(v.put('a', [0, 1], { revision: 1, validate: () => 1 })).toBe(true)
    expect(v.get('a')).toEqual([0, 1])

    const bad = tmp()
    fs.writeFileSync(path.join(bad, 'emb-ids.txt'), 'a\nb\n')
    fs.writeFileSync(path.join(bad, 'emb.f32'), Buffer.alloc(12))
    expect(() => new VectorIndex(bad)).toThrow(VectorCorruptError)
  })

  it('本地目录识别为 local；隔离探针通过', () => {
    const d = tmp()
    const info = detectFilesystem(d)
    expect(['local', 'unknown']).toContain(info.kind)
    resetNfsProbeCache()
    const probe = probeNfs(d)
    expect(probe.ok).toBe(true)
    expect(probe.checks.every((c) => c.ok)).toBe(true)
    // 探针不留下真实记忆文件
    expect(fs.existsSync(path.join(d, 'memory.jsonl'))).toBe(false)
  })
})

/**
 * 并发测试子进程：用真实 Node 进程验证跨进程锁，不用单进程 Promise 模拟。
 * 由 tests/concurrency.test.ts 通过 `node --import tsx` 启动。
 */
import * as fs from 'node:fs'
import { Memlite, Store, VectorIndex, LockManager, appendLine, type Entry } from '../../src/index'

const [mode, dir, ...rest] = process.argv.slice(2)

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n')
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  if (mode === 'store-put') {
    const prefix = rest[0] ?? 'w'
    const count = Number(rest[1] ?? 1)
    const store = new Store(dir, undefined, { concurrency: { mode: 'multi-process' } })
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      ids.push(store.put(`${prefix}-${i}-${Date.now()}`, `${prefix}-${i}`, [], 'concurrency'))
    }
    out({ ok: true, ids })
    return
  }
  if (mode === 'explicit-id') {
    const id = rest[0]!
    const mem = new Memlite({
      dataDir: dir,
      sensitiveGate: false,
      concurrency: { mode: 'multi-process' },
    })
    mem.open()
    try {
      await mem.remember(`explicit ${id}`, { id, title: 'explicit' })
      out({ ok: true })
    } catch (e) {
      out({ ok: false, code: (e as { code?: string }).code, message: String(e) })
    }
    return
  }
  if (mode === 'conditional') {
    const id = rest[0]!
    const revision = Number(rest[1])
    const go = rest[2]!
    const content = rest[3] ?? 'winner'
    const mem = new Memlite({
      dataDir: dir,
      sensitiveGate: false,
      concurrency: { mode: 'multi-process' },
    })
    mem.open()
    out({ ready: true })
    while (!fs.existsSync(go)) await sleep(5)
    try {
      const r = await mem.update(id, { content }, { expectedRevision: revision })
      out({ ok: true, revision: r.revision, content })
    } catch (e) {
      out({ ok: false, code: (e as { code?: string }).code, message: String(e) })
    }
    return
  }
  if (mode === 'hold') {
    const ms = Number(rest[0] ?? 1000)
    const lock = new LockManager({ dataDir: dir, concurrency: { mode: 'multi-process' } })
    lock.withLock(
      'data',
      'exclusive',
      'hold',
      () => {
        out({ locked: true, pid: process.pid })
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
        out({ released: true })
      },
      { createDir: true },
    )
    return
  }
  if (mode === 'crash-hold') {
    const lock = new LockManager({ dataDir: dir, concurrency: { mode: 'multi-process' } })
    lock.withLock(
      'data',
      'exclusive',
      'crash-hold',
      () => {
        out({ locked: true, pid: process.pid })
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
      },
      { createDir: true },
    )
    return
  }
  if (mode === 'write-loop') {
    const prefix = rest[0] ?? 'w'
    const count = Number(rest[1] ?? 1)
    const delay = Number(rest[2] ?? 0)
    const store = new Store(dir, undefined, { concurrency: { mode: 'multi-process' } })
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      ids.push(store.put(`${prefix}-${i}-${Math.random()}`, `${prefix}-${i}`, [], 'concurrency'))
      if (delay > 0) await sleep(delay)
    }
    out({ ok: true, ids })
    return
  }
  if (mode === 'compact') {
    const count = Number(rest[0] ?? 1)
    const store = new Store(dir, undefined, { concurrency: { mode: 'multi-process' } })
    for (let i = 0; i < count; i++) {
      store.compact()
      await sleep(5)
    }
    out({ ok: true })
    return
  }
  if (mode === 'log-append') {
    const count = Number(rest[0] ?? 1)
    for (let i = 0; i < count; i++) {
      const entry: Entry = {
        ts: Date.now() / 1000,
        query: `${process.pid}-${i}`,
        backend: 'bm25',
        limit: 5,
        fallback: '',
        source: 'concurrency-test',
        ms: 0,
        hits: [],
      }
      appendLine(dir, entry)
    }
    out({ ok: true })
    return
  }
  if (mode === 'vector-put') {
    const prefix = rest[0] ?? 'v'
    const count = Number(rest[1] ?? 1)
    const dim = Number(rest[2] ?? 4)
    const v = new VectorIndex(dir, { concurrency: { mode: 'multi-process' } })
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = `${prefix}${String(i).padStart(8, '0')}`
      const emb = Array.from({ length: dim }, (_, k) => (i + k + 1) / 10)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          v.put(id, emb, { revision: 0 })
          ids.push(id)
          break
        } catch (e) {
          if (attempt === 2) throw e
          await sleep(5)
        }
      }
    }
    out({ ok: true, ids })
    return
  }
  if (mode === 'snapshot-read') {
    const iterations = Number(rest[0] ?? 1)
    const store = new Store(dir, undefined, { concurrency: { mode: 'multi-process' } })
    let max = 0
    for (let i = 0; i < iterations; i++) {
      const snap = store.snapshot()
      max = Math.max(max, snap.count())
      if (snap.badLines !== 0) {
        out({ ok: false, bad_lines: snap.badLines })
        return
      }
      await sleep(2)
    }
    out({ ok: true, max })
    return
  }
  throw new Error(`unknown worker mode: ${mode}`)
}

main().catch((e) => {
  out({ ok: false, error: e instanceof Error ? e.message : String(e) })
  process.exitCode = 1
})

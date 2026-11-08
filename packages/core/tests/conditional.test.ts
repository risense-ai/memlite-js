import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Memlite, StaleVersionError, recordRevision, Store, type MemRecord } from '../src/index'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'memlite-cond-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('conditional writes', () => {
  it('starts at revision 0 and increments on update', async () => {
    const mem = new Memlite({ dataDir: tempDir(), sensitiveGate: false })
    mem.open()
    const id = await mem.remember('原正文', { title: '标题' })
    expect(recordRevision(mem.store.get(id)!)).toBe(0)
    const first = await mem.update(id, { content: '新正文' }, { expectedRevision: 0 })
    expect(first.revision).toBe(1)
    const second = await mem.update(id, { content: '再改' }, { expectedRevision: 1 })
    expect(second.revision).toBe(2)
    expect(mem.show(id)?.record.content).toBe('再改')
  })

  it('rejects a stale update and keeps the winner', async () => {
    const mem = new Memlite({ dataDir: tempDir(), sensitiveGate: false })
    mem.open()
    const id = await mem.remember('原正文', { title: '标题' })
    // 两个窗口同时读到 revision 0 → 第一个写入成功，第二个必须冲突。
    await mem.update(id, { content: '窗口 A' }, { expectedRevision: 0 })
    await expect(
      mem.update(id, { content: '窗口 B' }, { expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(StaleVersionError)
    expect(mem.show(id)?.record.content).toBe('窗口 A')
    expect(recordRevision(mem.store.get(id)!)).toBe(1)
  })

  it('guards attach and forget with the same revision token', async () => {
    const mem = new Memlite({ dataDir: tempDir(), sensitiveGate: false })
    mem.open()
    const parent = await mem.remember('父', { title: '父' })
    const child = await mem.remember('子', { title: '子' })
    const attached = mem.attach(child, parent, { expectedRevision: 0 })
    expect(attached.revision).toBe(1)
    expect(() => mem.attach(child, '', { expectedRevision: 0 })).toThrow(StaleVersionError)
    mem.forget(child, { expectedRevision: 1 })
    expect(mem.store.get(child)).toBeUndefined()
    await expect(() => mem.forget(child, { expectedRevision: 1 })).toThrow()
  })

  it('treats legacy rows without revision as ts-based versions', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    const legacy: MemRecord = {
      op: 'put',
      id: 'legacy000001',
      ts: 1_700_000_123.456,
      title: '旧记录',
      content: '旧正文',
      tags: [],
      project: '',
      extra: { parent_id: '' },
    }
    writeFileSync(path.join(dir, 'memory.jsonl'), JSON.stringify(legacy) + '\n')
    const store = new Store(dir)
    const record = store.get('legacy000001')!
    expect(recordRevision(record)).toBe(1_700_000_123_456)
    expect(store.putWithIdConditional('legacy000001', '新', '旧记录', [], '', 1_700_000_123_456)).toBeUndefined()
    expect(recordRevision(store.get('legacy000001')!)).toBe(1_700_000_123_457)
    expect(() =>
      store.putWithIdConditional('legacy000001', '再改', '旧记录', [], '', 1_700_000_123_456),
    ).toThrow(StaleVersionError)
    expect(readFileSync(path.join(dir, 'memory.jsonl'), 'utf8')).toContain('"revision":1700000123457')
  })

  it('a reopened store sees the same revision and rejects an old writer', async () => {
    const dir = tempDir()
    const first = new Memlite({ dataDir: dir, sensitiveGate: false })
    first.open()
    const id = await first.remember('正文', { title: '标题' })
    const oldExpected = recordRevision(first.store.get(id)!)
    const second = new Memlite({ dataDir: dir, sensitiveGate: false })
    second.open()
    const updated = await second.update(id, { content: '新版本' }, { expectedRevision: oldExpected })
    expect(updated.revision).toBe(1)
    await expect(first.update(id, { content: '旧窗口' }, { expectedRevision: oldExpected })).rejects.toBeInstanceOf(
      StaleVersionError,
    )
  })
})

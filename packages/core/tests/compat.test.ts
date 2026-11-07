/**
 * 与 Rust memlite 的互通测试（compat.md §八）：
 * 1. 读 Rust 写的库：Rust remember → JS Store 读出并可检索
 * 2. 写 JS 写的库：JS put → Rust `memlite recall` 能命中
 * 3. RRF 一致性：同查询两版返回顺序一致（BM25 档，允许小数误差）
 *
 * 须提供 Rust memlite 二进制：环境变量 MEMLITE_RS_BIN 指向可执行文件；
 * 未提供时整组跳过（CI 里由上层 workflow 先构建或传入）。
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store'
import { bm25 } from '../src/bm25'
import { recallSearch } from '../src/recall'

const RS_BIN = process.env['MEMLITE_RS_BIN'] ?? ''

const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-compat-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function rs(dir: string, ...args: string[]): string {
  return execFileSync(RS_BIN, ['--data-dir', dir, ...args], { encoding: 'utf8' })
}

const maybe = RS_BIN !== '' && fs.existsSync(RS_BIN) ? describe : describe.skip

maybe('读 Rust 写的库（Rust remember → JS 读 + 命中）', () => {
  it('JS Store 读出 Rust 条目并可 BM25 检索', () => {
    const d = tmp()
    rs(d, 'remember', 'Rust 写入的记忆：nginx 504 超时排查', '--title', 'rust 写 nginx')
    rs(d, 'remember', '第二条正文内容', '--title', '第二条')
    const s = new Store(d)
    expect(s.count()).toBe(2)
    const hit = bm25(s.all(), 'nginx 超时', 5, '')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit[0].record.title).toBe('rust 写 nginx')
    // 契约字段：flatten 平铺可读
    const rec = hit[0].record
    expect(rec.op).toBe('put')
    expect(rec.id).toMatch(/^[0-9a-f]{12}$/)
  })
})

maybe('写 JS 写的库（JS put → Rust recall 命中）', () => {
  it('Rust memlite recall 命中 JS 写入条目', () => {
    const d = tmp()
    const s = new Store(d)
    s.put('JS 写入的记忆：Redis 大 key 排查', 'js 写 redis', [], '')
    const out = rs(d, 'recall', 'Redis 大 key', '--json')
    const j = JSON.parse(out)
    expect(j.hits.length).toBeGreaterThan(0)
    expect(j.hits[0].title).toBe('js 写 redis')
  })
})

maybe('RRF 一致性（BM25 排序两版一致）', () => {
  it('同一小库同查询，JS bm25 序 = Rust recall --json 序', () => {
    const d = tmp()
    const s = new Store(d)
    s.put('cargo build 慢用 sccache 加速二次编译', 'rust 编译优化', [], '')
    s.put('番茄炒蛋的做法', '菜谱', [], '')
    s.put('rust 编译缓存 sccache 配置详解', 'sccache 配置', [], '')
    s.put('docker 磁盘清理 prune', 'docker 清理', [], '')
    const query = 'rust 编译'
    // JS 序
    const jsOrder = bm25(s.all(), query, 5, '').map((h) => h.record.id)
    // Rust 序（--json 命中含 id 与 title）
    const out = rs(d, 'recall', query, '--json')
    const rustOrder = (JSON.parse(out).hits as Array<{ id: string }>).map((h) => h.id)
    expect(rustOrder.length).toBe(jsOrder.length)
    expect(rustOrder).toEqual(jsOrder)
  })
})

maybe('del 墓碑互通（Rust forget → JS 读不到）', () => {
  it('Rust 删除后 JS 重载无此条', () => {
    const d = tmp()
    rs(d, 'remember', '将被删除的正文', '--title', '将删')
    const out = rs(d, 'list', '--json')
    const id = (JSON.parse(out)[0] as { id: string }).id
    rs(d, 'forget', id)
    const s = new Store(d)
    expect(s.get(id)).toBeUndefined()
    expect(s.deleted.has(id)).toBe(true)
  })
})

describe('compat 前置说明', () => {
  it('未提供 MEMLITE_RS_BIN 时跳过（如实标注）', () => {
    if (RS_BIN === '') {
      console.warn('跳过互通测试：未设 MEMLITE_RS_BIN（CI 上层须构建 Rust memlite 并传入）')
    }
    expect(true).toBe(true)
  })
})

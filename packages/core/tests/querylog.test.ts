import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOG_FILE, Log, appendLine, exportLog, type Entry } from '../src/querylog'

const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-qlog-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function entry(q: string, ids: string[]): Entry {
  return {
    ts: 1000.0,
    query: q,
    backend: 'semantic',
    limit: 10,
    fallback: '',
    source: 'cli',
    ms: 12,
    hits: ids.map((i) => ({ id: i, score: 0.5, title: '题' })),
  }
}

describe('append_then_load_counts', () => {
  it('落盘后冷载聚 counts', () => {
    const d = tmp()
    appendLine(d, entry('甲', ['a', 'b']))
    appendLine(d, entry('乙', ['b', 'c']))
    const log = new Log(d)
    expect(log.totalCount()).toBe(2)
    expect(log.countOf('b')).toBe(2)
    expect(log.countOf('a')).toBe(1)
    expect(log.countOf('zz')).toBe(0)
    expect(log.recent(1)[0].query).toBe('乙')
  })
})

describe('append_updates_in_memory', () => {
  it('常驻视图就地增量且与冷载一致', () => {
    const d = tmp()
    const log = new Log(d)
    log.append(d, entry('甲', ['a']))
    log.append(d, entry('乙', ['a', 'b']))
    expect(log.countOf('a')).toBe(2)
    expect(log.totalCount()).toBe(2)
    // 与冷载一致
    const cold = new Log(d)
    expect(cold.countOf('a')).toBe(2)
    expect(cold.totalCount()).toBe(2)
  })
})

describe('bad_lines_counted_not_fatal', () => {
  it('坏行计数不致命', () => {
    const d = tmp()
    appendLine(d, entry('甲', ['a']))
    fs.writeFileSync(path.join(d, LOG_FILE), '{坏行}\n')
    const log = new Log(d)
    expect(log.totalCount()).toBe(0)
    expect((log.stats(1) as Record<string, unknown>)['bad_lines']).toBe(1)
  })
})

describe('stats_and_export', () => {
  it('汇总档位/来源/回退/top；导出训练集与 since 过滤', () => {
    const d = tmp()
    appendLine(d, entry('甲', ['a', 'b']))
    const miss = entry('乙', [])
    miss.backend = 'bm25'
    miss.source = 'web'
    miss.fallback = 'user'
    appendLine(d, miss)
    const log = new Log(d)
    const st = log.stats(5)
    expect(st['queries_total']).toBe(2)
    expect(st['zero_hit']).toBe(1)
    expect((st['backend'] as Record<string, unknown>)['semantic']).toBe(1)
    expect((st['source'] as Record<string, unknown>)['web']).toBe(1)
    expect(st['fallback_user']).toBe(1)
    // 并列次数的排序不稳定，按 id 查而非取首元素
    const top = st['top'] as Array<Record<string, unknown>>
    expect(top.length).toBe(2)
    for (const want of ['a', 'b']) {
      const hit = top.find((t) => t['id'] === want)
      expect(hit).toBeDefined()
      expect(hit!['count']).toBe(1)
    }
    expect(st['distinct_recalled']).toBe(2)

    const out = path.join(d, 'export.jsonl')
    const n = exportLog(d, out, 0.0)
    expect(n).toBe(2)
    const first = JSON.parse(fs.readFileSync(out, 'utf8').split('\n')[0])
    expect(first['query']).toBe('甲')
    expect(first['positive'][0]).toBe('a')
    // since 过滤
    expect(exportLog(d, out, 5000.0)).toBe(0)
  })
})

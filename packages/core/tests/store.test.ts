import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DATA_FILE, Store, parentId, importance, kind } from '../src/store'

const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-js-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('put_get_delete_reload', () => {
  it('存取删重载', () => {
    const d = tmp()
    const s = new Store(d)
    const rid = s.put('测试记忆：Python 3.12', 'py312', ['python'], 'demo')
    expect(s.count()).toBe(1)
    expect(s.get(rid)?.tags).toEqual(['python'])
    s.delete(rid)
    expect(s.count()).toBe(0)
    const s2 = new Store(d)
    expect(s2.get(rid)).toBeUndefined()
    expect(s2.deleted.has(rid)).toBe(true)
  })
})

describe('empty_content_rejected', () => {
  it('空正文拒绝', () => {
    const s = new Store(tmp())
    expect(() => s.put('   ', '', [], '')).toThrow('content 为空')
  })
})

describe('bad_line_tolerated', () => {
  it('坏行计数不致命', () => {
    const d = tmp()
    const s = new Store(d)
    s.put('正常条', '', [], '')
    fs.appendFileSync(path.join(d, DATA_FILE), '{bad json\n')
    fs.appendFileSync(
      path.join(d, DATA_FILE),
      '{"op":"put","id":"x1","ts":1.0,"title":"","content":"坏行后正常条","tags":[],"project":""}\n',
    )
    const s2 = new Store(d)
    expect(s2.badLines).toBe(1)
    expect(s2.count()).toBe(2)
  })
})

describe('querylog_file_not_loaded_as_records', () => {
  it('检索日志同目录共存：既不当归档分块，也不计入坏行', () => {
    const d = tmp()
    const s = new Store(d)
    s.put('真记忆', '真', [], '')
    fs.writeFileSync(
      path.join(d, 'memory.querylog.jsonl'),
      '{"ts":1.0,"query":"q","backend":"bm25","limit":10,"hits":[]}',
    )
    const s2 = new Store(d)
    expect(s2.count()).toBe(1)
    expect(s2.badLines).toBe(0)
  })
})

describe('rotation_and_reload', () => {
  it('超限轮转且重载全量', () => {
    const d = tmp()
    const s = new Store(d, 500)
    for (let i = 0; i < 20; i++) {
      s.put(`记忆内容第 ${i} 条，${'充长度'.repeat(10)}`, `t${i}`, [], '')
    }
    const stats = s.fileStats()
    expect(stats.length).toBeGreaterThan(1) // 应发生轮转
    expect(stats[stats.length - 1][0]).toBe(DATA_FILE)
    const s2 = new Store(d, 500)
    expect(s2.count()).toBe(20)
  })
})

describe('tombstone_in_new_chunk_overrides_old', () => {
  it('新块的墓碑压过旧块的 put', () => {
    const d = tmp()
    const s = new Store(d, 400)
    const rid = s.put('第一条老记忆', 'old', [], '')
    for (let i = 0; i < 10; i++) {
      s.put(`填充记忆 ${i} ${'字'.repeat(30)}`, `f${i}`, [], '')
    }
    s.delete(rid)
    const s2 = new Store(d, 400)
    expect(s2.get(rid)).toBeUndefined()
  })
})

describe('compact_collapses_chunks', () => {
  it('压实归并归档', () => {
    const d = tmp()
    const s = new Store(d, 400)
    s.put('存活条', 'k', [], '')
    for (let i = 0; i < 10; i++) {
      s.put(`填充 ${i} ${'字'.repeat(30)}`, `f${i}`, [], '')
    }
    s.compact()
    expect(s.fileStats().length).toBe(1)
  })
})

describe('short_id_prefix_resolve', () => {
  it('前缀命中与未命中', () => {
    const s = new Store(tmp())
    const rid = s.put('x', '', [], '')
    expect(s.resolve(rid.slice(0, 6))).toBeDefined()
    expect(s.resolve('zzzz')).toBeUndefined()
  })
})

describe('resolve_by_exact_title_unique', () => {
  it('纲名唯一命中即取，重复标题不取', () => {
    const s = new Store(tmp())
    const rid = s.put('x', '编程开发', [], '')
    expect(s.resolve('编程开发')?.id).toBe(rid)
    // 重复标题不取（歧义回落前缀路）
    s.put('y', '编程开发', [], '')
    expect(s.resolve('编程开发')).toBeUndefined()
  })
})

describe('put_child_requires_existing_parent', () => {
  it('父须在库，认因后因链可得', () => {
    const s = new Store(tmp())
    expect(() => s.putChild('c', '', [], '', 'nope')).toThrow('目标因（父）不存在: nope')
    const pid = s.putChild('p', '父', [], '', '')
    const cid = s.putChild('c', '子', [], '', pid)
    expect(parentId(s.get(cid)!)).toBe(pid)
    expect(s.ancestorChain(cid)).toEqual([pid])
  })
})

describe('reparent_checked_blocks_cycle_and_self', () => {
  it('自挂与挂后代皆拒，合法改挂与升根可行', () => {
    const s = new Store(tmp())
    const a = s.putChild('a', '甲', [], '', '')
    const b = s.putChild('b', '乙', [], '', a)
    const c = s.putChild('c', '丙', [], '', b)
    // 自挂
    expect(() => s.reparentChecked(a, a)).toThrow('不能挂自己')
    // 挂后代成环（a 挂到 c 下 → c 是 a 后代）
    expect(() => s.reparentChecked(a, c)).toThrow('防环：新父是本条的后代')
    // 合法改挂：c 升到 a 下
    s.reparentChecked(c, a)
    expect(s.ancestorChain(c)).toEqual([a])
    // 升根
    s.reparentChecked(b, '')
    expect(s.ancestorChain(b)).toEqual([])
  })
})

describe('update_put_with_id_preserves_parent_and_meta', () => {
  it('update 后 parent_id/importance/kind 不丢', () => {
    const d = tmp()
    const s0 = new Store(d)
    const pid = s0.putChild('p', '父', [], '', '')
    const cid = s0.putChild('c', '子', [], '', pid)
    // 直写一行带 importance/kind 的 put（模拟迁移库字段），再走 update
    const line = `{"op":"put","id":"${cid}","ts":2.0,"title":"子","content":"c","tags":[],"project":"","parent_id":"${pid}","importance":"important","kind":"Task"}`
    fs.appendFileSync(path.join(d, DATA_FILE), line + '\n')
    // 重开装载手写行（内存索引不会自发重载），再走 update
    const s = new Store(d)
    s.putWithId(cid, '改后正文', '改题', ['t'], '')
    const after = s.get(cid)!
    expect(parentId(after)).toBe(pid)
    expect(importance(after)).toBe('important')
    expect(kind(after)).toBe('Task')
    expect(after.content).toBe('改后正文')
  })
})

describe('children_sorted_by_ts_roots_excluded', () => {
  it('子条按 ts 升序，空父=根集', () => {
    const s = new Store(tmp())
    const p = s.putChild('p', '父', [], '', '')
    const k1 = s.putChild('k1', '', [], '', p)
    const k2 = s.putChild('k2', '', [], '', p)
    expect(s.children(p).map((r) => r.id)).toEqual([k1, k2])
    expect(s.roots().length).toBe(1)
    expect(s.children('').length).toBe(1) // 空父=根集
  })
})

describe('ancestor_chain_survives_dirty_cycle_data', () => {
  it('脏数据成环时 chain 封顶不挂死', () => {
    const d = tmp()
    const s = new Store(d)
    const a = s.putChild('a', '', [], '', '')
    const b = s.putChild('b', '', [], '', a)
    s.reparent(a, b) // 故意造环（绕过 reparentChecked）：a→b→a
    const chain = new Store(d).ancestorChain(a)
    expect(chain.length).toBeLessThanOrEqual(64)
  })
})

describe('versions_and_counts', () => {
  it('versions 保历史、tag/project 频次按存活条计、行数与文件统计', () => {
    const s = new Store(tmp())
    const rid = s.put('第一版', '题', ['t1', 't2'], 'proj')
    const other = s.put('其他', '他', ['t1'], '')
    s.putWithId(rid, '第二版', '题2', ['t1'], 'proj')
    const vers = s.versions(rid)
    expect(vers.length).toBe(2)
    expect(vers[0].content).toBe('第一版')
    expect(vers[1].content).toBe('第二版')
    // 频次只数存活条（LWW 后 tags 已被第二版覆盖）；other 无 project 归「（无）」
    expect(s.tagCounts()).toEqual([
      ['t1', 2],
      ['t2', 0],
    ].slice(0, 1))
    expect(s.projectCounts()).toEqual([
      ['proj', 1],
      ['（无）', 1],
    ])
    expect(s.lineCount()).toBe(3)
    expect(s.fileStats()).toEqual([[DATA_FILE, fs.statSync(path.join(s.dataDir, DATA_FILE)).size]])
    expect(other).toBeDefined()
  })
})

describe('del_line_shape', () => {
  it('del 墓碑行形状与契约一致', () => {
    const d = tmp()
    const s = new Store(d)
    const rid = s.put('正文', '', [], '')
    s.delete(rid)
    const lines = fs.readFileSync(path.join(d, DATA_FILE), 'utf8').trim().split('\n')
    const del = JSON.parse(lines[lines.length - 1])
    expect(del).toEqual({
      op: 'del',
      id: rid,
      ts: del.ts,
      title: '',
      content: '',
      tags: [],
      project: '',
    })
  })
})

describe('put_line_shape_compat', () => {
  it('put 行形状与 Rust 契约示例一致（flatten 平铺）', () => {
    const d = tmp()
    const s = new Store(d)
    const pid = s.put('父', '纲', [], '')
    const rid = s.putChild('子正文', '子', ['t'], 'proj', pid)
    const rec = JSON.parse(fs.readFileSync(path.join(d, DATA_FILE), 'utf8').trim().split('\n')[1])
    expect(rec.op).toBe('put')
    expect(rec.id).toBe(rid)
    expect(rec.title).toBe('子')
    expect(rec.content).toBe('子正文')
    expect(rec.tags).toEqual(['t'])
    expect(rec.project).toBe('proj')
    expect(rec.parent_id).toBe(pid)
    expect(typeof rec.ts).toBe('number')
  })
})

describe('put_full', () => {
  it('显式 id/ts/extra 存入；id 冲突即拒', () => {
    const d = tmp()
    const s = new Store(d)
    const parent = s.put('父正文', '父', [], '')
    const rid = s.putFull({
      id: 'abcd1234abcd',
      ts: 1700000000,
      content: '导入正文',
      title: '导入条',
      tags: ['obsidian'],
      project: 'demo',
      parent,
      extra: { source_hash: 'deadbeef', obsidian_path: '编程/Rust.md', importance: 'important' },
    })
    expect(rid).toBe('abcd1234abcd')
    const rec = s.get(rid)!
    expect(rec.ts).toBe(1700000000)
    expect(rec.extra['source_hash']).toBe('deadbeef')
    expect(rec.extra['obsidian_path']).toBe('编程/Rust.md')
    expect(rec.extra['importance']).toBe('important')
    expect(parentId(rec)).toBe(parent)
    // id 冲突拒绝
    expect(() =>
      s.putFull({ id: rid, content: '另一条', title: '', tags: [], project: '' }),
    ).toThrow('id 已存在')
    // parent 不存在拒绝
    expect(() =>
      s.putFull({ content: '孤条', title: '', tags: [], project: '', parent: 'nonexist00' }),
    ).toThrow('目标因（父）不存在')
  })

  it('extra 夹带 parent_id 以 parent 参数为准（防悬空指针）', () => {
    const s = new Store(tmp())
    const pid = s.put('父', '', [], '')
    const rid = s.putFull({
      content: '正文',
      title: '',
      tags: [],
      project: '',
      parent: pid,
      extra: { parent_id: 'fake-parent' },
    })
    expect(parentId(s.get(rid)!)).toBe(pid)
  })

  it('无 id 自动生成；重载保留 extra', () => {
    const d = tmp()
    const s = new Store(d)
    const rid = s.putFull({ content: '正文', title: '题', tags: [], project: '', ts: 123 })
    expect(rid).not.toBe('')
    const s2 = new Store(d)
    expect(s2.get(rid)?.ts).toBe(123)
  })
})

describe('put_with_id_extra_patch', () => {
  it('extraPatch 合并覆盖，parent_id 不被补丁改写', () => {
    const d = tmp()
    const s = new Store(d)
    const pid = s.put('父', '', [], '')
    const rid = s.putFull({
      id: 'patch01patch01',
      content: '旧正文',
      title: '旧题',
      tags: [],
      project: '',
      parent: pid,
      extra: { source_hash: 'h1', keep_me: 'yes' },
    })
    s.putWithId(rid, '新正文', '新题', ['t'], 'p', { source_hash: 'h2' })
    const rec = s.get(rid)!
    expect(rec.content).toBe('新正文')
    expect(rec.title).toBe('新题')
    expect(rec.tags).toEqual(['t'])
    expect(rec.extra['source_hash']).toBe('h2')
    expect(rec.extra['keep_me']).toBe('yes')
    expect(parentId(rec)).toBe(pid)
    const s2 = new Store(d)
    expect(s2.get(rid)?.extra['source_hash']).toBe('h2')
  })
})

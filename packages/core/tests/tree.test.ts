import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DATA_FILE, Store, importance, serializeRecord } from '../src/store'
import {
  TreeScope,
  causalLines,
  chainView,
  outline,
  renderTree,
  treeJson,
} from '../src/tree'

const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-tree-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 建三层树：纲A → 子B/C → 孙D（D 挂 B 下） */
function seed(): [Store, string, string, string, string] {
  const s = new Store(tmp())
  const a = s.putChild('纲A正文', '纲A', [], '', '')
  const b = s.putChild('子B正文', '子B', [], '', a)
  const c = s.putChild('子C正文', '子C', [], '', a)
  const d = s.putChild('孙D正文', '孙D', [], '', b)
  return [s, a, b, c, d]
}

describe('render_three_levels_prefix_inherits_bar', () => {
  it('非末孙竖线继承、末孙空格继承、根头存在', () => {
    const [s, , b] = seed()
    // 子B 下再添一子E：D 为非末子、E 为末子
    s.putChild('孙E正文', '孙E', [], '', b)
    const scope = new TreeScope(s)
    const lines = renderTree(scope, undefined, 3)
    const joined = lines.join('\n')
    // respire 累积分支算法（两仓源码一致＋装机 rsrs level=1→3→5 实证）：
    // 子行前缀 = 父前缀(含父分支) + (末子? "   " : "│  ") + 本行分支
    expect(joined).toContain('├─ │  ├─ 孙D')
    expect(joined).toContain('├─    └─ 孙E')
    expect(lines[0]).toContain('🌳 因果树根 [')
    expect(lines[0]).toContain('纲A')
  })
})

describe('render_from_subtree_and_depth_zero', () => {
  it('from 模式表头+自身；depth 0 不展子；未知节点报错', () => {
    const [s, a, b] = seed()
    const scope = new TreeScope(s)
    const lines = renderTree(scope, a, 0)
    // respire from-mode：表头一行 + 自身一行（depth 0 不展子）
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('因果树（自')
    expect(lines[1]).toContain('纲A')
    const lines2 = renderTree(scope, b, 3)
    expect(lines2[1]).toContain('子B')
    expect(lines2[2]).toContain('孙D')
    expect(() => renderTree(scope, 'nonexist', 3)).toThrow()
  })
})

describe('scope_trivial_out_and_orphan_promoted', () => {
  it('trivial 出树、父出树后子提根', () => {
    const d = tmp()
    const s = new Store(d)
    const a = s.putChild('纲', '纲', [], '', '')
    const b = s.putChild('子', '子', [], '', a)
    // 父降为 trivial → 子出作用域链、提为根（直写 trivial 行）
    const rec = { ...s.get(a)!, extra: { ...s.get(a)!.extra, importance: 'trivial' } }
    fs.appendFileSync(path.join(d, DATA_FILE), serializeRecord(rec) + '\n')
    const s2 = new Store(d)
    const scope = new TreeScope(s2)
    expect(scope.get(a)).toBeUndefined()
    expect(scope.roots).toContain(b)
    expect(scope.childrenOf(a)).toEqual([])
  })
})

describe('outline_full_depth_and_count', () => {
  it('全深 4 节点，根行=短id+标题', () => {
    const [s, a] = seed()
    const scope = new TreeScope(s)
    const [lines, n] = outline(scope, undefined)
    expect(n).toBe(4)
    expect(lines[0]).toBe(`[${a.slice(0, 8)}] 纲A`)
    const [sub, n2] = outline(scope, a)
    expect(n2).toBe(4)
    expect(sub.length).toBe(4)
  })
})

describe('chain_view_ancestors_root_first_descendants', () => {
  it('因链根在前不含本条；果链层号正确；未知报错', () => {
    const [s, a, b, , d] = seed()
    const v = chainView(s, d, 3)
    expect(v.ancestors.map((r) => r.id)).toEqual([a, b])
    expect(v.entry.id).toBe(d)
    expect(v.descendants.length).toBe(0) // 叶无果
    const v2 = chainView(s, a, 3)
    expect(v2.ancestors.length).toBe(0)
    expect(v2.descendants.length).toBe(3) // B + C + D
    expect(v2.descendants[0][0]).toBe(1) // 直接子层 1
    expect(v2.descendants[2][0]).toBe(2) // 孙层 2
    expect(() => chainView(s, 'nope', 3)).toThrow()
    expect(b).toBeDefined()
  })
})

describe('causal_lines_show_cause_and_effect', () => {
  it('因链/纲L1/果行齐备；孤条为空', () => {
    const [s, , b, , d] = seed()
    const joined = causalLines(s, b).join('\n')
    expect(joined).toContain('🔺因链')
    expect(joined).toContain('纲A')
    expect(joined).toContain('▸纲L1')
    expect(joined).toContain('🔻果')
    expect(joined).toContain('孙D')
    // 根且叶 → 空
    const s2 = new Store(tmp())
    const lone = s2.put('孤条', '孤', [], '')
    expect(causalLines(s2, lone)).toEqual([])
    expect(d).toBeDefined()
  })
})

describe('causal_lines_lists_overflow_hint', () => {
  it('超 3 子出溢出提示', () => {
    const s = new Store(tmp())
    const root = s.put('纲', 'R', [], '')
    for (let i = 0; i < 5; i++) s.putChild(`子${i}`, `S${i}`, [], '', root)
    const joined = causalLines(s, root).join('\n')
    expect(joined).toContain('…另 2 个果 → memlite chain')
  })
})

describe('tree_json_nested', () => {
  it('全深嵌套结构与 from 起点', () => {
    const [s, a] = seed()
    const scope = new TreeScope(s)
    const roots = treeJson(scope, undefined)
    expect(roots.length).toBe(1)
    expect(roots[0].children.length).toBe(2) // 纲A 下两子
    expect(roots[0].leaf).toBe(false)
    const sub = treeJson(scope, a)
    expect(sub.length).toBe(1)
    expect(sub[0].id).toBe(a)
  })
})

describe('importance_helper', () => {
  it('trivial 直写行可读出', () => {
    const d = tmp()
    const s = new Store(d)
    const a = s.put('x', '题', [], '')
    const rec = { ...s.get(a)!, extra: { ...s.get(a)!.extra, importance: 'trivial' } }
    fs.appendFileSync(path.join(d, DATA_FILE), JSON.stringify(flatten(rec)) + '\n')
    const s2 = new Store(d)
    expect(importance(s2.get(a)!)).toBe('trivial')
    function flatten(r: { op: string; id: string; ts: number; title: string; content: string; tags: string[]; project: string; extra: Record<string, unknown> }): Record<string, unknown> {
      const o: Record<string, unknown> = { op: r.op, id: r.id, ts: r.ts, title: r.title, content: r.content, tags: r.tags, project: r.project }
      for (const [k, v] of Object.entries(r.extra)) o[k] = v
      return o
    }
  })
})

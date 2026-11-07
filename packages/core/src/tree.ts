/**
 * 因果树与因果链：树作用域、子树渲染、outline 目录、chain 深挖、recall/show 的因果视界行。
 * 语义对齐 respire（memocap CLI）：父=因/子=果，根在前，trivial 出树、父失效提根。
 */
import { importance, kind, parentId, type MemRecord, type Store } from './store'

/** 纲 L1 概览取父内容头的字数（对齐 respire ANCESTOR_PARENT_CAP=140） */
export const PARENT_L1_CAP = 140

/** 树作用域内的节点（trivial 出树；父不在作用域则提为根）。结构由 kids（含 '' 键=根集）完整表达。 */
export class TreeScope {
  readonly nodes: MemRecord[]
  private readonly kids: Map<string, string[]>
  readonly roots: string[]

  constructor(store: Store) {
    const inScope = new Set<string>()
    for (const r of store.records.values()) {
      if (importance(r) !== 'trivial') inScope.add(r.id)
    }
    this.nodes = store.all().filter((r) => inScope.has(r.id))
    this.nodes.sort((a, b) => a.ts - b.ts)
    this.kids = new Map()
    this.roots = []
    for (const r of this.nodes) {
      const p = parentId(r)
      if (p === '' || !inScope.has(p)) {
        this.roots.push(r.id)
      } else {
        const list = this.kids.get(p)
        if (list) list.push(r.id)
        else this.kids.set(p, [r.id])
      }
    }
  }

  childrenOf(id: string): string[] {
    return this.kids.get(id) ?? []
  }

  get(id: string): MemRecord | undefined {
    return this.nodes.find((r) => r.id === id)
  }
}

/** 带子树深度的节点（tree --json 用） */
export interface TreeNode {
  id: string
  title: string
  kind: string
  level: number
  leaf: boolean
  children: TreeNode[]
}

function label(scope: TreeScope, id: string): string {
  const r = scope.get(id)
  const t = r && r.title !== '' ? r.title : id.slice(0, 8)
  return t
}

function id8(id: string): string {
  return id.slice(0, 8)
}

/** 树渲染（对齐 respire 格式）：
 * 根头 `🌳 因果树根 [id8] title`，节点行 `{prefix}{title} [id8] {kind} 🍃叶?`，
 * 分支 `├─ `/`└─ `，竖线继承用 next_prefix（三层不串行）。 */
export function renderTree(scope: TreeScope, from: string | undefined, depth: number): string[] {
  function render(node: string, depth: number, prefix: string, out: string[], seen: Set<string>): void {
    if (!seen.has(node)) {
      seen.add(node)
    } else {
      out.push(`${prefix}（环，截断）[${id8(node)}]`)
      return
    }
    const title = label(scope, node)
    const kids = scope.childrenOf(node)
    const meta = scope.get(node) ? kind(scope.get(node)!) : ''
    const leaf = kids.length === 0 ? ' 🍃叶' : ''
    out.push(`${prefix}${title} [${id8(node)}] ${meta}${leaf}`)
    if (depth === 0) return
    const n = kids.length
    for (let i = 0; i < n; i++) {
      const kid = kids[i]
      const last = i === n - 1
      const branch = last ? '└─ ' : '├─ '
      // 子层前缀继承 next_prefix：非末子的后代要带竖线，否则三层渲染串行
      const nextPrefix = prefix + (last ? '   ' : '│  ')
      render(kid, depth - 1, nextPrefix + branch, out, seen)
    }
    seen.delete(node)
  }

  const out: string[] = []
  const seen = new Set<string>()
  if (from !== undefined) {
    if (!scope.get(from)) throw new Error(`无此节点或已出树: ${from}`)
    out.push(`🌳 因果树（自 ${from}）`)
    render(from, depth, '', out, seen)
  } else {
    if (scope.roots.length === 0) {
      return ['（无根节点——库内皆叶，因果树未成形）']
    }
    for (const r of scope.roots) {
      out.push(`🌳 因果树根 [${id8(r)}] ${label(scope, r)}`)
      const kids = scope.childrenOf(r)
      const n = kids.length
      for (let i = 0; i < n; i++) {
        const last = i === n - 1
        const branch = last ? '└─ ' : '├─ '
        render(kids[i], Math.max(depth - 1, 0), branch, out, seen)
      }
    }
  }
  return out
}

/** outline 全深目录：`[id8] title` 逐层缩进（AI 梳理先读此），返回行 + 节点数。 */
export function outline(scope: TreeScope, from: string | undefined): [string[], number] {
  function walk(node: string, indent: number, out: string[], seen: Set<string>): void {
    if (seen.has(node)) return
    seen.add(node)
    out.push(`${'  '.repeat(indent)}[${id8(node)}] ${label(scope, node)}`)
    for (const kid of scope.childrenOf(node)) walk(kid, indent + 1, out, seen)
  }
  const out: string[] = []
  const seen = new Set<string>()
  if (from !== undefined) {
    if (!scope.get(from)) throw new Error(`无此节点或已出树: ${from}`)
    walk(from, 0, out, seen)
  } else {
    for (const r of scope.roots) walk(r, 0, out, seen)
  }
  return [out, out.length]
}

/** tree --json 结构（全深树，from 定起点） */
export function treeJson(scope: TreeScope, from: string | undefined): TreeNode[] {
  function build(node: string, level: number, seen: Set<string>): TreeNode {
    const isNew = !seen.has(node)
    seen.add(node)
    const kids = isNew ? scope.childrenOf(node) : []
    const meta = scope.get(node)
    return {
      id: node,
      title: label(scope, node),
      kind: meta ? kind(meta) : '',
      level,
      leaf: kids.length === 0,
      children: kids.map((k) => build(k, level + 1, seen)),
    }
  }
  const seen = new Set<string>()
  if (from !== undefined) {
    if (!scope.get(from)) throw new Error(`无此节点或已出树: ${from}`)
    return [build(from, 0, seen)]
  }
  return scope.roots.map((r) => build(r, 0, seen))
}

/** 因果链深挖（对齐 respire chain）：因链全文（根在前）+ 本条 + 果链下探 depth 层。 */
export interface ChainView {
  ancestors: MemRecord[]
  entry: MemRecord
  /** (层级 1..=depth, 记录)，遍历序与 Rust 一致（frontier pop） */
  descendants: Array<[number, MemRecord]>
}

export function chainView(store: Store, id: string, depth: number): ChainView {
  const entry = store.records.get(id)
  if (!entry) throw new Error(`记忆不存在: ${id}`)
  const ancestors = store
    .ancestorChain(id)
    .map((pid) => store.records.get(pid))
    .filter((r): r is MemRecord => r !== undefined)
  const descendants: Array<[number, MemRecord]> = []
  const frontier: Array<[string, number]> = [[id, 1]]
  const seen = new Set<string>([id])
  while (frontier.length > 0) {
    const [cur, lv] = frontier.pop()!
    if (lv > depth) continue
    for (const c of store.children(cur)) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      descendants.push([lv, c])
      frontier.push([c.id, lv + 1])
    }
  }
  return { ancestors, entry, descendants }
}

/** recall/show 因果视界行（对齐 respire print_causal）：
 * 🔺因链标题链 → ▸纲L1 父内容头 → 🔻果（3 子带摘要 + 各孙标题）→ 超量提示走 chain。
 * 返回行列表（无父无子返回空）。 */
export function causalLines(store: Store, id: string): string[] {
  const out: string[] = []
  const titleOf = (pid: string): string => {
    const p = store.records.get(pid)
    return p && p.title !== '' ? p.title : id8(pid)
  }
  const chain = store.ancestorChain(id).filter((pid) => store.records.has(pid))
  if (chain.length > 0) {
    const parts = chain.map((pid) => titleOf(pid))
    out.push(`   🔺因链: ${parts.join(' ← ')} → 本条为其果`)
    const lastPid = chain[chain.length - 1]
    const p = store.records.get(lastPid)
    if (p) {
      const head = [...p.content].slice(0, PARENT_L1_CAP).join('').replace(/\n/g, ' ')
      if (head.trim() !== '') {
        out.push(`   ▸纲L1 「${titleOf(lastPid)}」 ${head}`)
      }
    }
  }
  const children = store.children(id)
  if (children.length > 0) {
    out.push(`   🔻果: ${children.length} 个（本条又为下游之因）`)
    for (const c of children.slice(0, 3)) {
      const title = c.title !== '' ? c.title : id8(c.id)
      const summary = [...c.content].slice(0, 60).join('').replace(/\n/g, ' ')
      const sep = summary === '' ? '' : ' · '
      out.push(`      └─ [${id8(c.id)}] ${title}${sep}${summary}`)
      const grands = store.children(c.id)
      const shown = Math.min(3, grands.length)
      for (const g of grands.slice(0, shown)) {
        const gt = g.title !== '' ? g.title : id8(g.id)
        out.push(`         └─ ${gt} [${id8(g.id)}]`)
      }
      if (grands.length > shown) {
        out.push(`         …另 ${grands.length - shown} 个`)
      }
    }
    if (children.length > 3) {
      out.push(`      …另 ${children.length - 3} 个果 → memlite chain ${id8(id)}`)
    }
  }
  return out
}

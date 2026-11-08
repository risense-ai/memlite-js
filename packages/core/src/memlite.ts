/**
 * Memlite 主类：可嵌入本地记忆引擎的装配点（proposal §6 契约）。
 * 组合 Store / VectorIndex / querylog / recall 主流程 / 因果树 / 敏感闸 / 同步 / 嵌入档。
 * 用法：`new Memlite(config, deps)` → `open()` → `recall/remember/...` → `close()`。
 */
import { defaultTitle } from './bm25'
import * as path from 'node:path'
import type { ConfigCtx } from './config'
import { concurrencyMerged, embeddingMerged, resolveDataDir, userDataDir } from './config'
import { noneEmbedder } from './embedding/none'
import { makeOpenAIEmbedder } from './embedding/openai'
import type {
  Embedder,
  EmbeddingProvider,
  EmbedderDeps,
} from './embedding/provider'
import {
  LOG_FILE,
  Log,
  exportLog,
  type Entry,
  type Hit,
} from './querylog'
import { recallSearch, searchOnce, type RecallBackend } from './recall'
import { scan } from './sensitive'
import {
  CHUNK_BYTES,
  Store,
  nowTs,
  parentId,
  recordRevision,
  type MemRecord,
  type StoreSnapshot,
} from './store'
import * as syncMod from './sync'
import {
  TreeScope,
  causalLines,
  chainView,
  outline,
  renderTree,
  treeJson,
  type ChainView,
  type TreeNode,
} from './tree'
import { VectorIndex } from './vectors'
import type { ConcurrencyConfig } from './lock'

export interface MemliteConfig {
  /** 缺省走 resolveDataDir（CLI > MEMLITE_DATA > 工作区 > 用户级 > ~/memlite-data） */
  dataDir?: string
  /** 默认 10 */
  recallLimit?: number
  sync?: { auto?: boolean; remote?: string }
  embedding?: {
    provider: EmbeddingProvider
    /** openai-compatible 必填 */
    apiBase?: string
    /** 默认 'BAAI/bge-m3' */
    model?: string
    /** 宿主 credentials 引用名；默认 'MEMLITE_EMBED_API_KEY' */
    credentialRef?: string
    /** 默认 30000 */
    timeoutMs?: number
  }
  /** 默认 true */
  sensitiveGate?: boolean
  /** 并发协议（默认 single-writer/local；多进程需显式开启） */
  concurrency?: ConcurrencyConfig
}

export interface MemliteDeps extends EmbedderDeps {
  /** 直接注入 Embedder（测试或宿主全托管）；优先于 config.embedding 解析 */
  embedder?: Embedder
  /** 环境/工作区上下文（dataDir 与用户级回退目录的解析来源；缺省取真实 process） */
  ctx?: ConfigCtx
}

export interface RememberOpts {
  title?: string
  tags?: string[]
  project?: string
  /** 认因挂载：本条之因（父）——id/前8位/纲名皆可；空=根 */
  parent?: string
  /** 显式 id（导入桥回填 frontmatter.id 用）；已在库即拒 */
  id?: string
  /** 显式 ts 秒级时间戳（导入回填创建时间用）；缺省取当前 */
  ts?: number
  /** 额外平铺字段（source_hash/obsidian_path/importance/kind 等）；parent_id 由 parent 参数管 */
  extra?: Record<string, unknown>
  /** 同步等待嵌入完成（缺省异步不阻塞主路径） */
  awaitEmbedding?: boolean
}

export interface RecallOpts {
  limit?: number
  project?: string
  /** 强制词面档 */
  bm25Only?: boolean
}

/** 条件写选项：给 expectedRevision 时，版本不一致抛 StaleVersionError（进程内原子）。 */
export interface WriteOptions {
  expectedRevision?: number
}

export interface CausalNeighbor {
  id: string
  title: string
}

export interface RecallHit {
  score: number
  id: string
  ts: number
  title: string
  content: string
  tags: string[]
  project: string
  ancestors: CausalNeighbor[]
  children: CausalNeighbor[]
}

export interface RecallResult {
  backend: RecallBackend
  /** 空=本库命中；"user"=项目级无命中回退用户级 */
  fallback: string
  ms: number
  hits: RecallHit[]
}

const DEFAULT_CREDENTIAL_REF = 'MEMLITE_EMBED_API_KEY'
const DEFAULT_MODEL = 'BAAI/bge-m3'
const DEFAULT_TIMEOUT_MS = 30_000

export class Memlite {
  readonly config: Required<Omit<MemliteConfig, 'dataDir' | 'sync' | 'embedding' | 'concurrency'>> &
    Pick<MemliteConfig, 'dataDir' | 'sync' | 'embedding' | 'concurrency'>
  private readonly deps: MemliteDeps
  private storeRef: Store | undefined
  private vectorsRef: VectorIndex | undefined
  private logRef: Log | undefined
  private embedderRef: Embedder | undefined
  private readonly logger: { warn(msg: string): void }

  constructor(config: MemliteConfig = {}, deps: MemliteDeps = {}) {
    this.config = {
      dataDir: config.dataDir,
      sync: config.sync,
      embedding: config.embedding,
      concurrency: config.concurrency,
      recallLimit: config.recallLimit ?? 10,
      sensitiveGate: config.sensitiveGate ?? true,
    }
    this.deps = deps
    this.logger = deps.logger ?? { warn: () => {} }
  }

  /** 数据目录（构造时已解析定型） */
  get dataDir(): string {
    if (this.config.dataDir) return this.config.dataDir
    return resolveDataDir(undefined, this.deps.ctx)
  }

  get store(): Store {
    if (!this.storeRef) this.open()
    return this.storeRef!
  }

  get vectors(): VectorIndex {
    if (!this.vectorsRef) {
      this.vectorsRef = new VectorIndex(this.dataDir, {
        concurrency: this.config.concurrency,
        logger: this.logger,
      })
    }
    return this.vectorsRef
  }

  /** 同一代次的只读快照（recall/show/list/tree/status 共用，避免跨代拼装）。 */
  snapshot(): StoreSnapshot {
    return this.store.snapshot('memlite.snapshot')
  }

  /** 检索日志常驻视图（counts 全量聚合） */
  get log(): Log {
    if (!this.logRef) {
      this.logRef = new Log(this.dataDir, {
        concurrency: this.config.concurrency,
        logger: this.logger,
      })
    }
    return this.logRef
  }

  /** 打开（幂等；DSH 插件在 ctx.on('ready') 调） */
  open(): this {
    if (!this.storeRef) {
      this.storeRef = new Store(this.dataDir, CHUNK_BYTES, {
        concurrency: this.config.concurrency,
        logger: this.logger,
      })
    }
    return this
  }

  /** 关闭（释放常驻索引；dispose 钩子调） */
  close(): void {
    this.storeRef = undefined
    this.vectorsRef = undefined
    this.logRef = undefined
    this.embedderRef = undefined
  }

  /** 嵌入档解析（切档重建实例即生效；结果缓存） */
  async resolveEmbedder(): Promise<Embedder> {
    if (this.deps.embedder) return this.deps.embedder
    if (this.embedderRef) return this.embedderRef
    const emb = this.config.embedding
    const provider: EmbeddingProvider = emb?.provider ?? 'none'
    if (provider === 'none') return noneEmbedder
    let embedder: Embedder
    if (provider === 'host') {
      if (!this.deps.hostEmbedder) {
        throw new Error("embedding.provider=host 须在 deps.hostEmbedder 注入宿主 Embedder")
      }
      embedder = this.deps.hostEmbedder
    } else {
      if (!emb?.apiBase) {
        throw new Error('embedding.provider=openai-compatible 须配 apiBase')
      }
      embedder = await makeOpenAIEmbedder(
        {
          provider,
          apiBase: emb.apiBase,
          model: emb.model ?? DEFAULT_MODEL,
          credentialRef: emb.credentialRef ?? DEFAULT_CREDENTIAL_REF,
          timeoutMs: emb.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        this.deps,
      )
    }
    this.embedderRef = embedder
    return embedder
  }

  /** 写前敏感闸（config.sensitiveGate=true 时启用）：命中即拒，提示改存位置指针。 */
  scanOrReject(text: string): void {
    if (!this.config.sensitiveGate) return
    const hits = scan(text)
    if (hits.length > 0) {
      throw new Error(
        `拒绝入库：命中敏感信息（${hits.join('、')}）。改存位置指针（如「密码在 ~/.env」）后重试。`,
      )
    }
  }

  /** 存记忆：主路径只落 JSONL（立即可被 BM25 命中），嵌入异步执行，失败仅记日志。 */
  async remember(content: string, opts: RememberOpts = {}): Promise<string> {
    const title = opts.title ?? ''
    const probe = `${title}\n${content}`
    this.scanOrReject(probe)
    const finalTitle = title.trim() === '' ? defaultTitle(content) : title.trim()
    let parentFull = ''
    if (opts.parent && opts.parent !== '') {
      const p = this.snapshot().resolve(opts.parent)
      if (!p) throw new Error(`目标因（父）不存在: ${opts.parent}`)
      parentFull = p.id
    }
    const hasFull = opts.id !== undefined || opts.ts !== undefined || opts.extra !== undefined
    const rid = hasFull
      ? this.store.putFull({
          id: opts.id,
          ts: opts.ts,
          content,
          title: finalTitle,
          tags: opts.tags ?? [],
          project: opts.project ?? '',
          parent: parentFull,
          extra: opts.extra,
        })
      : this.store.putChild(content, finalTitle, opts.tags ?? [], opts.project ?? '', parentFull)
    const committed = this.store.peek(rid)
    const revision = committed ? recordRevision(committed) : 0
    const emb = this.config.embedding
    if ((emb?.provider ?? 'none') !== 'none' || this.deps.embedder) {
      const task = this.embedRecord(rid, finalTitle, content, revision)
      if (opts.awaitEmbedding) await task
    }
    return rid
  }

  /** 侧车异步写入：失败不拦存入，只记日志。 */
  private async embedRecord(
    rid: string,
    title: string,
    content: string,
    revision: number,
  ): Promise<boolean> {
    try {
      const embedder = await this.resolveEmbedder()
      if ((embedder.dim ?? 1) === 0) return false
      const v = await embedder.embed(`${title}\n${content}`)
      if (v.length === 0) return false
      return this.writeVectorIfCurrent(rid, v, revision)
    } catch (e) {
      this.logger.warn(
        `记忆 ${rid} 嵌入失败，将被语义档跳过: ${e instanceof Error ? e.message : String(e)}`,
      )
      return false
    }
  }

  /**
   * 向量写入：数据共享锁保证 revision 在“校验—落盘”期间不变，
   * 向量排他锁内再做一次 revision 对照；内容已变或记录已删则不写。
   */
  private writeVectorIfCurrent(rid: string, vector: ArrayLike<number>, revision: number): boolean {
    return this.store.withSnapshot('memlite.vector-write', (snap) => {
      const current = snap.get(rid)
      if (!current || recordRevision(current) !== revision) return false
      return this.vectors.put(rid, vector, {
        revision,
        validate: () => {
          const r = snap.get(rid)
          return r ? recordRevision(r) : undefined
        },
      })
    })
  }

  /** 检索：BM25 必算 → 嵌入 → RRF；项目级无命中回退用户级；写 querylog；带因果视界。 */
  async recall(query: string, opts: RecallOpts = {}): Promise<RecallResult> {
    const t0 = performance.now()
    const limit = opts.limit ?? this.config.recallLimit
    const project = opts.project ?? ''
    const bm25Only = opts.bm25Only ?? false
    const embedder = await this.tryEmbedder()
    const snap = this.store.snapshot('recall')
    let { backend, hits } = await searchOnce(
      snap.all(),
      bm25Only ? undefined : this.safeVectors(this.dataDir),
      embedder,
      query,
      { limit, project, bm25Only },
      this.logger,
    )
    // 两档查序：解析库非用户级（项目级）且没搜到 → 自动回退用户级
    let fallbacked = false
    let causalStore: StoreSnapshot = snap
    const userDir = userDataDir(this.deps.ctx)
    if (hits.length === 0 && normalize(this.dataDir) !== normalize(userDir)) {
      const userStore = new Store(userDir, CHUNK_BYTES, {
        concurrency: this.config.concurrency,
        logger: this.logger,
      })
      const userSnap = userStore.snapshot('recall.user')
      const r2 = await searchOnce(
        userSnap.all(),
        bm25Only ? undefined : this.safeVectors(userDir),
        embedder,
        query,
        { limit, project, bm25Only },
        this.logger,
      )
      if (r2.hits.length > 0) {
        backend = r2.backend
        hits = r2.hits
        fallbacked = true
        causalStore = userSnap
      }
    }
    // 落检索日志：一次查询一行（含零命中与回退），失败只提示不拦检索
    const ms = Math.round(performance.now() - t0)
    const entry: Entry = {
      ts: nowTs(),
      query,
      backend,
      limit,
      fallback: fallbacked ? 'user' : '',
      source: 'library',
      ms,
      hits: hits.map((h) => ({ id: h.record.id, score: h.score, title: h.record.title }) satisfies Hit),
    }
    try {
      this.log.append(this.dataDir, entry)
    } catch (e) {
      this.logger.warn(`检索日志写入失败：${e instanceof Error ? e.message : String(e)}`)
    }
    return {
      backend,
      fallback: fallbacked ? 'user' : '',
      ms,
      hits: hits.map((h) => this.toRecallHit(causalStore, h.score, h.record)),
    }
  }

  /** 向量文件损坏不应拖垮词面检索：构造失败只告警并回退 BM25。 */
  private safeVectors(dir: string): VectorIndex | undefined {
    try {
      if (normalize(dir) === normalize(this.dataDir)) return this.vectors
      return new VectorIndex(dir, {
        concurrency: this.config.concurrency,
        logger: this.logger,
      })
    } catch (e) {
      this.logger.warn(`向量侧车不可用，回退 BM25: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }

  private toRecallHit(causalStore: StoreSnapshot, score: number, r: MemRecord): RecallHit {
    return {
      score: Math.round(score * 10000) / 10000,
      id: r.id,
      ts: r.ts,
      title: r.title,
      content: r.content,
      tags: r.tags,
      project: r.project,
      ancestors: causalStore
        .ancestorChain(r.id)
        .filter((pid) => causalStore.records.has(pid))
        .map((pid) => ({ id: pid, title: causalStore.records.get(pid)!.title })),
      children: causalStore.children(r.id).map((c) => ({ id: c.id, title: c.title })),
    }
  }

  /** 嵌入档解析失败（如 credentialRef 取不到）不算致命——回退 BM25 并告警。 */
  private async tryEmbedder(): Promise<Embedder | undefined> {
    try {
      return await this.resolveEmbedder()
    } catch (e) {
      this.logger.warn(`嵌入档不可用，走纯 BM25: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }

  /** 看全文：resolve（id/前缀/纲名）+ 因果邻居。 */
  show(id: string): {
    record: MemRecord
    ancestors: CausalNeighbor[]
    children: Array<CausalNeighbor & { summary: string }>
    causalLines: string[]
  } | undefined {
    const s = this.snapshot()
    const r = s.resolve(id)
    if (!r) return undefined
    const titleOf = (pid: string): string => {
      const p = s.records.get(pid)
      return p && p.title !== '' ? p.title : pid.slice(0, 8)
    }
    return {
      record: r,
      ancestors: s
        .ancestorChain(r.id)
        .filter((pid) => s.records.has(pid))
        .map((pid) => ({ id: pid, title: titleOf(pid) })),
      children: s.children(r.id).map((c) => ({
        id: c.id,
        title: c.title,
        summary: [...c.content].slice(0, 80).join(''),
      })),
      causalLines: causalLines(s, r.id),
    }
  }

  /** 列最近（ts 降序） */
  list(limit = 20): MemRecord[] {
    return this.snapshot()
      .all()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
  }

  /** 删记忆（resolve 支持 id/前缀/纲名）；给 expectedRevision 时做条件删除。 */
  forget(id: string, options: WriteOptions = {}): string {
    const r = this.store.resolve(id)
    if (!r) throw new Error(`记忆不存在: ${id}`)
    if (options.expectedRevision !== undefined) {
      this.store.deleteConditional(r.id, options.expectedRevision)
    } else {
      this.store.delete(r.id)
    }
    return r.id
  }

  /** 收编挂链：子条挂到 parent 之下（防自挂防环）；parent='' 升根。 */
  attach(
    id: string,
    parent: string,
    options: WriteOptions = {},
  ): { child: string; parent: string; revision: number } {
    return this.attachLike(id, parent, options)
  }

  /** 因果下沉：本条挂到 parent 下成为其果（同一 reparent 语义） */
  demote(
    id: string,
    parent: string,
    options: WriteOptions = {},
  ): { child: string; parent: string; revision: number } {
    return this.attachLike(id, parent, options)
  }

  private attachLike(
    id: string,
    parent: string,
    options: WriteOptions = {},
  ): { child: string; parent: string; revision: number } {
    const s = this.store
    const child = s.resolve(id)
    if (!child) throw new Error(`记忆不存在: ${id}`)
    let parentFull = ''
    if (parent !== '') {
      const p = s.resolve(parent)
      if (!p) throw new Error(`目标因（父）不存在: ${parent}`)
      parentFull = p.id
    }
    if (options.expectedRevision !== undefined) {
      s.reparentCheckedConditional(child.id, parentFull, options.expectedRevision)
    } else {
      s.reparentChecked(child.id, parentFull)
    }
    const updated = s.get(child.id)
    return { child: child.id, parent: parentFull, revision: updated ? recordRevision(updated) : 0 }
  }

  /** 因果上浮：本条升为更上游之因（挂到祖父/根，果链随之） */
  promote(id: string): { id: string; newParent: string } {
    const s = this.store
    const me = s.resolve(id)
    if (!me) throw new Error(`记忆不存在: ${id}`)
    const oldParent = parentId(me)
    if (oldParent === '') return { id: me.id, newParent: '' }
    const parentRec = s.get(oldParent)
    // 新因 = 原因的因（祖父）；祖父不在库则升根
    const grandparent = parentRec ? parentId(parentRec) : ''
    s.reparentChecked(me.id, grandparent)
    return { id: me.id, newParent: grandparent }
  }

  /** 因果链深挖：因链全文（根在前）+ 本条 + 果链下探 depth 层 */
  chain(id: string, depth = 3): ChainView {
    const s = this.snapshot()
    const r = s.resolve(id)
    if (!r) throw new Error(`记忆不存在: ${id}`)
    return chainView(s, r.id, depth)
  }

  /** 因果树渲染（mode 缺省 render；from 支持 id/前8位/纲名） */
  tree(opts: { from?: string; depth?: number; mode?: 'render' | 'outline' | 'json' } = {}):
    | string[]
    | { lines: string[]; count: number }
    | TreeNode[] {
    const depth = opts.depth ?? 3
    const s = this.snapshot()
    let fromFull: string | undefined
    if (opts.from !== undefined && opts.from !== '') {
      const r = s.resolve(opts.from)
      if (!r) throw new Error(`记忆不存在: ${opts.from}`)
      fromFull = r.id
    }
    const scope = new TreeScope(s)
    const mode = opts.mode ?? 'render'
    if (mode === 'outline') {
      const [lines, count] = outline(scope, fromFull)
      return { lines, count }
    }
    if (mode === 'json') return treeJson(scope, fromFull)
    return renderTree(scope, fromFull, depth)
  }

  /** 就地改一条（同 id 追加新版本；未传字段保留原值）。extra 按键合并，parent_id 不随 patch 变（改挂走 attach）。侧车向量跟着更新（失败不拦）。
   * 给 options.expectedRevision 时做版本条件写：检查与 JSONL 追加在同一同步段内，冲突抛 StaleVersionError。 */
  async update(
    id: string,
    patch: { title?: string; content?: string; tags?: string[]; project?: string; extra?: Record<string, unknown> },
    options: WriteOptions = {},
  ): Promise<{ id: string; title: string; embedded: boolean; revision: number }> {
    const probe = `${patch.title ?? ''}\n${patch.content ?? ''}`
    if (probe.trim() !== '') this.scanOrReject(probe)
    const old = this.snapshot().resolve(id)
    if (!old) throw new Error(`记忆不存在: ${id}`)
    const newTitle = patch.title ?? old.title
    const newContent = patch.content ?? old.content
    const newTags = patch.tags ?? old.tags
    const newProject = patch.project ?? old.project
    if (newContent.trim() === '') throw new Error('content 不能为空')
    const { parent_id: _lockedParent, ...extraPatch } = patch.extra ?? {}
    if (options.expectedRevision !== undefined) {
      this.store.putWithIdConditional(
        old.id,
        newContent,
        newTitle,
        newTags,
        newProject,
        options.expectedRevision,
        extraPatch,
      )
    } else {
      this.store.putWithId(old.id, newContent, newTitle, newTags, newProject, extraPatch)
    }
    const updated = this.store.peek(old.id)
    const revision = updated ? recordRevision(updated) : 0
    let embedded = false
    const embedder = await this.tryEmbedder()
    if (embedder && (embedder.dim ?? 1) !== 0) {
      try {
        const v = await embedder.embed(`${newTitle}\n${newContent}`)
        if (v.length > 0) embedded = this.writeVectorIfCurrent(old.id, v, revision)
      } catch (e) {
        this.logger.warn(
          `记忆 ${old.id} 嵌入失败，将被语义档跳过: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    return { id: old.id, title: newTitle, embedded, revision }
  }

  /** 给缺向量或向量已过期的记忆批量回填（ts 升序；按批计算、逐批受锁提交）。 */
  async reembed(opts: { batchSize?: number } = {}): Promise<{
    total: number
    embedded: number
    failed: number
    failures: string[]
  }> {
    const embedder = await this.resolveEmbedder()
    if ((embedder.dim ?? 0) === 0) throw new Error('嵌入档未开启')
    const batchSize = Math.min(Math.max(Math.trunc(opts.batchSize ?? 16), 1), 1_000)
    const all = this.snapshot().all().sort((a, b) => a.ts - b.ts)
    const vecSnap = this.vectors.snapshot('reembed.scan')
    const pending = all.filter((r) => {
      if (!vecSnap.has(r.id)) return true
      const recorded = vecSnap.revisionOf(r.id)
      return recorded !== undefined && recorded !== recordRevision(r)
    })
    const failures: string[] = []
    let done = 0
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize)
      for (const r of batch) {
        const revision = recordRevision(r)
        try {
          const v = await embedder.embed(`${r.title}\n${r.content}`)
          if (v.length === 0) continue
          if (this.writeVectorIfCurrent(r.id, v, revision)) done++
          else failures.push(`${r.id}: 嵌入期间记忆已更新或删除，跳过`)
        } catch (e) {
          failures.push(`${r.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    return { total: all.length, embedded: done, failed: failures.length, failures }
  }

  /** 同步状态（dirty / local_sha / has_remote） */
  syncStatus(): ReturnType<typeof syncMod.status> {
    return syncMod.status(this.dataDir)
  }

  /** 一次完整 git 同步（白名单 add + pathspec commit + rebase + push + sha 核验） */
  sync(): ReturnType<typeof syncMod.sync> {
    return syncMod.sync(this.dataDir, {
      concurrency: this.config.concurrency,
      logger: this.logger,
    })
  }

  /** 压实：只留存活重写回单文件，删归档。返回压实前行数。 */
  compact(): number {
    return this.store.compact()
  }

  /** 全库状态概览（同一代次快照；并发/锁后端一并可诊断）。 */
  async status(): Promise<Record<string, unknown>> {
    const s = this.store
    const snap = s.snapshot('status')
    const embedder = this.deps.embedder
    const emb = this.config.embedding
    const files = s.fileStats().map(([file, bytes]) => ({ file, bytes }))
    let vectorStatus: Record<string, unknown>
    try {
      vectorStatus = this.vectors.status()
    } catch (e) {
      vectorStatus = {
        error: 'VECTOR_CORRUPT',
        message: e instanceof Error ? e.message : String(e),
      }
    }
    let syncStatus: unknown
    try {
      syncStatus = await this.syncStatus()
    } catch {
      syncStatus = null
    }
    return {
      data_dir: this.dataDir,
      records: snap.count(),
      lines: s.lineCount(),
      bad_lines: snap.badLines,
      generation: snap.generation,
      files,
      // 兼容旧宿主：vectors 仍是数量；详细状态在 vector_status
      vectors: typeof vectorStatus['count'] === 'number' ? vectorStatus['count'] : 0,
      vector_status: vectorStatus,
      concurrency: s.concurrencyStatus(),
      querylog: LOG_FILE,
      embedding: {
        provider: emb?.provider ?? 'none',
        configured: Boolean(this.deps.embedder) || (emb?.provider ?? 'none') !== 'none',
        api_base: emb?.apiBase ?? '',
        model: emb?.model ?? DEFAULT_MODEL,
        resolved_dim: embedder?.dim,
      },
      sync: syncStatus,
    }
  }

  /** 检索日志：最近 n 条流水 */
  querylogRecent(n: number): Array<Record<string, unknown>> {
    return this.log.recentJson(n)
  }

  /** 检索日志：汇总 */
  querylogStats(top = 10): Record<string, unknown> {
    return this.log.stats(top)
  }

  /** 检索日志：导出训练集 */
  querylogExport(out: string, since = 0): number {
    return exportLog(this.dataDir, out, since, {
      concurrency: this.config.concurrency,
      logger: this.logger,
    })
  }
}

function normalize(p: string): string {
  return path.resolve(p).replace(/\/+$/, '') || '/'
}

/** 从分层配置文件与环境变量解析 MemliteConfig（兼容 Rust 写的 config.json，含 api_key 读取）。
 * 密钥策略：credentialResolver 直接回落 config.json 的 embedding.api_key（向后兼容）；
 * 宿主已注入 credentialResolver 时以其为准。 */
export function memliteFromFiles(deps: MemliteDeps = {}, ctx?: ConfigCtx): Memlite {
  const merged = embeddingMerged(ctx)
  const apiBase = typeof merged['api_base'] === 'string' ? merged['api_base'] : undefined
  const apiKey = typeof merged['api_key'] === 'string' ? merged['api_key'] : undefined
  const model = typeof merged['model'] === 'string' ? merged['model'] : undefined
  const config: MemliteConfig = {
    dataDir: resolveDataDir(undefined, ctx),
    concurrency: concurrencyMerged(ctx),
    embedding:
      apiBase && apiKey && model
        ? { provider: 'openai-compatible', apiBase, model }
        : { provider: 'none' },
  }
  const resolver = deps.credentialResolver ?? (async () => apiKey)
  return new Memlite(config, { ...deps, credentialResolver: resolver })
}

/** 便捷重导出（内部模块在 index.ts 统一出口） */
export { recallSearch }

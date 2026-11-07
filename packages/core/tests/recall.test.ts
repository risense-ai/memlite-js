import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Memlite } from '../src/memlite'
import { LOG_FILE } from '../src/querylog'
import type { Embedder } from '../src/embedding/provider'

const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-recall-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function fixedEmbedder(table: Record<string, number[]>, dim = 2): Embedder {
  return {
    dim,
    async embed(text: string) {
      const v = table[text] ?? [0, 0]
      return Float32Array.from(v)
    },
  }
}

describe('recall 纯 BM25（none 档）', () => {
  it('命中并带因果视界；querylog 落行', async () => {
    const d = tmp()
    const mem = new Memlite({ dataDir: d })
    const pid = await mem.remember('nginx 反代超时。调大 timeout 解决。', { title: 'nginx 排查' })
    await mem.remember('番茄炒蛋的做法', { title: '菜谱' })
    await mem.remember('下游果条', { parent: pid })
    const r = await mem.recall('nginx 超时')
    expect(r.backend).toBe('bm25')
    expect(r.fallback).toBe('')
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits[0].id).toBe(pid)
    expect(r.hits[0].children.length).toBe(1)
    expect(r.ms).toBeGreaterThanOrEqual(0)
    // querylog 落行
    expect(fs.existsSync(path.join(d, LOG_FILE))).toBe(true)
    const line = JSON.parse(fs.readFileSync(path.join(d, LOG_FILE), 'utf8').trim().split('\n')[0])
    expect(line['backend']).toBe('bm25')
    expect(line['fallback']).toBe('')
    expect(line['hits'].length).toBeGreaterThan(0)
  })
})

describe('recall RRF（注入 embedder）', () => {
  it('语义+词面融合，backend=rrf', async () => {
    const d = tmp()
    // 甲乙都含「查询」（词面双命中），查询向量与甲同向 → 甲另有语义命中
    const emb: Embedder = {
      dim: 2,
      async embed(text: string) {
        return Float32Array.from(text === '查询' || text.includes('甲') ? [1, 0] : [0, 1])
      },
    }
    const mem = new Memlite({ dataDir: d }, { embedder: emb })
    const a = await mem.remember('查询相关的甲条', { title: '甲题', awaitEmbedding: true })
    await mem.remember('查询相关的乙条', { title: '乙题', awaitEmbedding: true })
    const r = await mem.recall('查询')
    expect(r.backend).toBe('rrf')
    expect(r.hits.length).toBe(2)
    expect(r.hits[0].id).toBe(a) // 甲双臂命中居首
  })
})

describe('recall 嵌入失败回退 BM25 不 throw', () => {
  it('embed 抛错时仍返回 BM25 结果', async () => {
    const d = tmp()
    const warns: string[] = []
    const boom: Embedder = {
      dim: 3,
      async embed() {
        throw new Error('网络炸了')
      },
    }
    const mem = new Memlite({ dataDir: d }, { embedder: boom, logger: { warn: (m) => warns.push(m) } })
    await mem.remember('可以命中的正文', { title: '题' })
    const r = await mem.recall('可以命中')
    expect(r.backend).toBe('bm25')
    expect(r.hits.length).toBe(1)
    expect(warns.some((w) => w.includes('嵌入失败'))).toBe(true)
  })
})

describe('项目级无命中回退用户级', () => {
  it('fallback=user，命中在回退库', async () => {
    const projectHome = tmp()
    const userHome = tmp()
    const userDir = path.join(userHome, 'memlite-data')
    const userMem = new Memlite({ dataDir: userDir })
    const uid = await userMem.remember('只存在用户级的记忆', { title: '用户级' })
    const mem = new Memlite({ dataDir: projectHome }, { ctx: { cwd: projectHome, home: userHome } })
    // 项目条与查询零词面重叠（否则项目级先命中就不触发回退）
    await mem.remember('alpha beta gamma', { title: 'zzz' })
    const r = await mem.recall('用户级')
    expect(r.fallback).toBe('user')
    expect(r.hits.length).toBe(1)
    expect(r.hits[0].id).toBe(uid)
    // 日志落项目级目录
    const line = JSON.parse(fs.readFileSync(path.join(projectHome, LOG_FILE), 'utf8').trim().split('\n')[0])
    expect(line['fallback']).toBe('user')
  })
})

describe('remember 嵌入失败仍返回 id', () => {
  it('主路径不依赖嵌入', async () => {
    const d = tmp()
    const warns: string[] = []
    const boom: Embedder = {
      dim: 3,
      async embed() {
        throw new Error('down')
      },
    }
    const mem = new Memlite(
      { dataDir: d, embedding: { provider: 'host' } },
      { hostEmbedder: boom, logger: { warn: (m) => warns.push(m) } },
    )
    const rid = await mem.remember('正文照存', { title: '题', awaitEmbedding: true })
    expect(rid).toBeDefined()
    expect(mem.store.count()).toBe(1)
    expect(warns.some((w) => w.includes('嵌入失败'))).toBe(true)
  })
})

describe('remember 敏感闸', () => {
  it('默认开启：命中即拒；关闭后放行', async () => {
    const d = tmp()
    const mem = new Memlite({ dataDir: d })
    await expect(mem.remember('密码是hunter2secret')).rejects.toThrow('拒绝入库')
    const memOff = new Memlite({ dataDir: d, sensitiveGate: false })
    const rid = await memOff.remember('密码是hunter2secret')
    expect(memOff.store.count()).toBe(1)
    expect(rid).toBeDefined()
  })
})

describe('remember 认因与默认标题', () => {
  it('parent resolve + 缺省截首句', async () => {
    const d = tmp()
    const mem = new Memlite({ dataDir: d })
    const pid = await mem.remember('父正文', { title: '父题' })
    const cid = await mem.remember('nginx 反代 504 超时。调大 timeout 解决。', { parent: pid })
    expect(mem.store.get(cid)!.title).toBe('nginx 反代 504 超时')
    expect(mem.store.ancestorChain(cid)).toEqual([pid])
    await expect(mem.remember('子正文', { parent: 'nope' })).rejects.toThrow('目标因（父）不存在')
  })
})

describe('openai-compatible mock fetch', () => {
  it('成功与 4xx 两路', async () => {
    const d = tmp()
    // 成功：remember 异步嵌入落侧车
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }),
      ),
    )
    const mem = new Memlite(
      {
        dataDir: d,
        embedding: { provider: 'openai-compatible', apiBase: 'https://api.test/v1' },
      },
      { credentialResolver: async () => 'sk-test' },
    )
    const rid = await mem.remember('正文', { title: '题', awaitEmbedding: true })
    expect(mem.vectors.has(rid)).toBe(true)
    // 4xx → recall 回退 BM25 不 throw
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 401 })),
    )
    const r2 = await mem.recall('正文')
    expect(r2.backend).toBe('bm25')
    expect(r2.hits.length).toBe(1)
  })
  it('credentialRef 取不到：初始化期报错', async () => {
    const d = tmp()
    const mem = new Memlite(
      {
        dataDir: d,
        embedding: { provider: 'openai-compatible', apiBase: 'https://api.test/v1' },
      },
      { credentialResolver: async () => undefined },
    )
    await expect(mem.resolveEmbedder()).rejects.toThrow('credentials 中未找到')
  })
})

describe('reembed', () => {
  it('跳过已有向量、未开启报错', async () => {
    const d = tmp()
    const none = new Memlite({ dataDir: d })
    await expect(none.reembed()).rejects.toThrow('嵌入档未开启')
    const emb = fixedEmbedder({}, 2)
    const mem = new Memlite({ dataDir: d }, { embedder: emb })
    const a = await mem.remember('甲', { title: '甲题', awaitEmbedding: true })
    const b = await mem.remember('乙', { title: '乙题', awaitEmbedding: true })
    expect(mem.vectors.count()).toBe(2)
    mem.vectors.put(b, [9, 9]) // 原地覆盖：已有向量仍在
    const res = await mem.reembed()
    expect(res.embedded).toBe(0) // 全部已有向量，跳过
    expect(res.failed).toBe(0)
    expect(mem.vectors.has(a)).toBe(true)
  })
})

describe('chain/tree/promote/attach/update 命令面', () => {
  it('与 Rust CLI 语义一致', async () => {
    const d = tmp()
    const mem = new Memlite({ dataDir: d })
    const a = await mem.remember('纲A正文', { title: '纲A' })
    const b = await mem.remember('子B正文', { title: '子B', parent: a })
    const c = await mem.remember('子C正文', { title: '子C', parent: a })
    const dd = await mem.remember('孙D正文', { title: '孙D', parent: b })
    // chain：因链根在前、果链层号
    const v = mem.chain(dd, 3)
    expect(v.ancestors.map((x) => x.id)).toEqual([a, b])
    const v2 = mem.chain(a, 3)
    expect(v2.descendants.length).toBe(3)
    // tree 渲染
    const lines = mem.tree({ mode: 'render', depth: 3 }) as string[]
    expect(lines[0]).toContain('🌳 因果树根 [')
    const ol = mem.tree({ mode: 'outline' }) as { count: number }
    expect(ol.count).toBe(4)
    // promote：C 上浮到祖父（A 的父=根）
    const p = mem.promote(c)
    expect(p.newParent).toBe('')
    // attach 防环
    expect(() => mem.attach(a, dd)).toThrow('防环')
    // update 保父链
    await mem.update(b, { content: '改后正文' })
    expect(mem.store.get(b)!.content).toBe('改后正文')
    expect(mem.store.get(b)!.extra['parent_id']).toBe(a)
  })
})

describe('querylog 便捷接口', () => {
  it('recent/stats/export', async () => {
    const d = tmp()
    const mem = new Memlite({ dataDir: d })
    await mem.remember('可命中正文', { title: '题' })
    await mem.recall('可命中')
    await mem.recall('可命中')
    expect(mem.querylogStats()['queries_total']).toBe(2)
    expect(mem.querylogRecent(1).length).toBe(1)
    const out = path.join(d, 'train.jsonl')
    expect(mem.querylogExport(out)).toBe(2)
  })
})

describe('remember 显式 id/ts/extra（导入桥）', () => {
  it('主类经 putFull 落库：id/ts/extra 全保留', async () => {
    const d = tmp()
    const mem = new Memlite({ dataDir: d })
    const pid = await mem.remember('父条', { title: '父' })
    const rid = await mem.remember('导入正文', {
      id: 'fixed12fixed12',
      ts: 1700000000,
      title: '导入条',
      tags: ['obsidian'],
      project: 'demo',
      parent: pid,
      extra: { source_hash: 'abc', importance: 'important', kind: 'Context' },
    })
    expect(rid).toBe('fixed12fixed12')
    const view = mem.show(rid)!
    expect(view.record.ts).toBe(1700000000)
    expect(view.record.extra['source_hash']).toBe('abc')
    expect(view.record.extra['importance']).toBe('important')
    expect(view.record.extra['kind']).toBe('Context')
    // id 冲突即拒
    await expect(
      mem.remember('重复', { id: rid, title: '' }),
    ).rejects.toThrow('id 已存在')
  })
})

describe('update extra 合并', () => {
  it('按键合并；parent_id 不随补丁变', async () => {
    const d = tmp()
    const mem = new Memlite({ dataDir: d })
    const pid = await mem.remember('父条', { title: '父' })
    const rid = await mem.remember('正文', {
      title: '题',
      parent: pid,
      extra: { source_hash: 'h1', keep: 'x' },
    })
    await mem.update(rid, { content: '新正文', extra: { source_hash: 'h2' } })
    const rec = mem.show(rid)!.record
    expect(rec.content).toBe('新正文')
    expect(rec.extra['source_hash']).toBe('h2')
    expect(rec.extra['keep']).toBe('x')
    expect(rec.extra['parent_id']).toBe(pid)
  })
})

describe('attach 升根', () => {
  it("attach(id, '') 摘到根", async () => {
    const d = tmp()
    const mem = new Memlite({ dataDir: d })
    const pid = await mem.remember('父条', { title: '父' })
    const rid = await mem.remember('子条', { parent: pid })
    mem.attach(rid, '')
    const rec = mem.show(rid)!.record
    expect(rec.extra['parent_id']).toBe('')
    expect(mem.show(pid)!.children.length).toBe(0)
  })
})

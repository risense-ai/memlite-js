import { describe, expect, it, vi } from 'vitest'
import { makeOpenAIEmbedder, EmbedError } from '../src/embedding/openai'
import { noneEmbedder } from '../src/embedding/none'
import { makeHostEmbedder } from '../src/embedding/host'
import type { EmbedderDeps } from '../src/embedding/provider'

describe('none 档', () => {
  it('embed 返回空向量，dim 0', async () => {
    const v = await noneEmbedder.embed('任意')
    expect(v.length).toBe(0)
    expect(noneEmbedder.dim).toBe(0)
  })
})

describe('openai 档 mock fetch', () => {
  const cfg = {
    provider: 'openai-compatible' as const,
    apiBase: 'https://api.test/v1/',
    model: 'BAAI/bge-m3',
    credentialRef: 'REF',
    timeoutMs: 1000,
  }
  const deps: EmbedderDeps = { credentialResolver: async () => 'sk-test' }

  it('成功：取 data[0].embedding，末尾斜杠归一', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const e = await makeOpenAIEmbedder(cfg, deps)
    const v = await e.embed('hello')
    expect([...v]).toEqual([1, 2, 3])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.test/v1/embeddings')
  })

  it('4xx → EmbedError(client)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    const e = await makeOpenAIEmbedder(cfg, deps)
    await expect(e.embed('x')).rejects.toMatchObject({ kind: 'client' })
  })

  it('5xx → EmbedError(server)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })))
    const e = await makeOpenAIEmbedder(cfg, deps)
    await expect(e.embed('x')).rejects.toMatchObject({ kind: 'server' })
  })

  it('网络不可达 → EmbedError(network)；超时 → EmbedError(timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const e = await makeOpenAIEmbedder(cfg, deps)
    await expect(e.embed('x')).rejects.toMatchObject({ kind: 'network' })
    const timeoutErr = new Error('The operation was aborted due to timeout')
    timeoutErr.name = 'TimeoutError'
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw timeoutErr
    }))
    await expect(e.embed('x')).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('响应形状不符 → EmbedError(shape)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"nope":1}', { status: 200 })))
    const e = await makeOpenAIEmbedder(cfg, deps)
    await expect(e.embed('x')).rejects.toMatchObject({ kind: 'shape' })
  })

  it('credentialRef 取不到：初始化期抛 EmbedError(credential)', async () => {
    await expect(
      makeOpenAIEmbedder(cfg, { credentialResolver: async () => undefined }),
    ).rejects.toMatchObject({ kind: 'credential' })
  })

  it('缺 credentialResolver 视同取不到', async () => {
    await expect(makeOpenAIEmbedder(cfg, {})).rejects.toBeInstanceOf(EmbedError)
  })
})

describe('host 档', () => {
  it('makeHostEmbedder 包装宿主函数', async () => {
    const e = makeHostEmbedder(async (text) => Float32Array.from([text.length, 1]), 2)
    const v = await e.embed('abc')
    expect([...v]).toEqual([3, 1])
    expect(e.dim).toBe(2)
  })
})

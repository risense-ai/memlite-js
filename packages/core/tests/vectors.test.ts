import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VectorIndex } from '../src/vectors'

const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-vec-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('put_get_roundtrip_dim_adaptive', () => {
  it('roundtrip 且重载从文件推 dim；维度不一致拒收', () => {
    const d = tmp()
    const v = new VectorIndex(d)
    v.put('a', [1.0, 2.0, 3.0])
    v.put('b', [4.0, 5.0, 6.0])
    const v2 = new VectorIndex(d) // 重载从文件推 dim
    expect(v2.dim).toBe(3)
    expect(v2.get('a')).toEqual([1.0, 2.0, 3.0])
    expect(v2.count()).toBe(2)
    expect(() => v2.put('c', [1.0])).toThrow('向量维度不一致') // 维度不一致拒收
  })
})

describe('overwrite_in_place', () => {
  it('同 id 原地覆盖不新增', () => {
    const d = tmp()
    const v = new VectorIndex(d)
    v.put('a', [1.0, 0.0])
    v.put('a', [0.0, 1.0])
    const v2 = new VectorIndex(d)
    expect(v2.count()).toBe(1)
    expect(v2.get('a')).toEqual([0.0, 1.0])
  })
})

describe('has_and_missing', () => {
  it('has/get 边界', () => {
    const d = tmp()
    const v = new VectorIndex(d)
    v.put('a', [0.5])
    expect(v.has('a')).toBe(true)
    expect(v.has('b')).toBe(false)
    expect(v.get('b')).toBeUndefined()
  })
})

describe('float32_le_format_compat', () => {
  it('emb.f32 为 packed f32 LE、emb-ids.txt 行号对齐（Rust 契约）', () => {
    const d = tmp()
    const v = new VectorIndex(d)
    v.put('abc123def456', [1.5, -2.25])
    const raw = fs.readFileSync(path.join(d, 'emb.f32'))
    expect(raw.length).toBe(8)
    expect(raw.readFloatLE(0)).toBeCloseTo(1.5)
    expect(raw.readFloatLE(4)).toBeCloseTo(-2.25)
    expect(fs.readFileSync(path.join(d, 'emb-ids.txt'), 'utf8').trim()).toBe('abc123def456')
  })
})

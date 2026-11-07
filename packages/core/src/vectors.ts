/**
 * 向量侧车：emb.f32（packed float32 LE）+ emb-ids.txt（id 顺序对齐）。
 * dim 自适应：首写定维，读时按 文件字节数/id 数 推导。
 * 与 Rust memlite vectors.rs 文件格式互通（compat.md §三）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export class VectorIndex {
  private readonly dir: string
  dim: number | undefined
  private ids: string[] = []
  private offset = new Map<string, number>()
  private cache: Buffer | undefined

  constructor(dir: string) {
    this.dir = dir
    let text: string | undefined
    try {
      text = fs.readFileSync(path.join(dir, 'emb-ids.txt'), 'utf8')
    } catch {
      text = undefined
    }
    if (text !== undefined) {
      for (const [i, line] of text.split('\n').entries()) {
        if (line !== '') {
          this.offset.set(line, i)
          this.ids.push(line)
        }
      }
    }
    if (this.dim === undefined && this.ids.length > 0) {
      try {
        const n = fs.statSync(path.join(dir, 'emb.f32')).size / 4
        if (n % this.ids.length === 0) this.dim = n / this.ids.length
      } catch {
        // 无 f32 文件保持 dim 未定
      }
    }
  }

  private f32Path(): string {
    return path.join(this.dir, 'emb.f32')
  }

  private loadCache(): void {
    if (this.cache !== undefined) return
    try {
      this.cache = fs.readFileSync(this.f32Path())
    } catch {
      this.cache = undefined
    }
  }

  get(rid: string): number[] | undefined {
    const idx = this.offset.get(rid)
    if (idx === undefined) return undefined
    const dim = this.dim
    if (dim === undefined) return undefined
    this.loadCache()
    const raw = this.cache
    if (raw === undefined) return undefined
    const start = idx * dim * 4
    const end = start + dim * 4
    if (end > raw.length) return undefined
    const out = new Array<number>(dim)
    for (let i = 0; i < dim; i++) out[i] = raw.readFloatLE(start + i * 4)
    return out
  }

  /** 首写定维；维度不符拒收；同 id 原地覆盖；写前失效缓存。 */
  put(rid: string, emb: ArrayLike<number>): void {
    if (this.dim === undefined) this.dim = emb.length
    if (emb.length !== this.dim) {
      throw new Error(`向量维度不一致: ${emb.length} != ${this.dim}`)
    }
    this.cache = undefined
    const buf = Buffer.alloc(emb.length * 4)
    for (let i = 0; i < emb.length; i++) buf.writeFloatLE(emb[i], i * 4)
    const existing = this.offset.get(rid)
    if (existing !== undefined) {
      // 同 id 原地覆盖
      const fd = fs.openSync(this.f32Path(), 'r+')
      try {
        fs.writeSync(fd, buf, 0, buf.length, existing * emb.length * 4)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      return
    }
    const fd = fs.openSync(this.f32Path(), 'a')
    try {
      fs.writeSync(fd, buf)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    const idsFd = fs.openSync(path.join(this.dir, 'emb-ids.txt'), 'a')
    try {
      fs.writeSync(idsFd, rid + '\n')
      fs.fsyncSync(idsFd)
    } finally {
      fs.closeSync(idsFd)
    }
    this.offset.set(rid, this.ids.length)
    this.ids.push(rid)
  }

  has(rid: string): boolean {
    return this.offset.has(rid)
  }

  count(): number {
    return this.ids.length
  }
}

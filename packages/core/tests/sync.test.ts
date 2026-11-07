import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { findRepo, sync, whitelisted } from '../src/sync'

const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-sync-'))
  dirs.push(d)
  return d
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('whitelist_covers_querylog', () => {
  it('memory*.jsonl/meta.json/README.md 在白名单，emb 与杂文件不在', () => {
    const d = tmp()
    for (const f of ['memory.jsonl', 'memory.querylog.jsonl', 'memory-1.jsonl', 'emb.f32', 'notes.txt']) {
      fs.writeFileSync(path.join(d, f), 'x')
    }
    const w = whitelisted(d)
    expect(w).toContain('memory.jsonl')
    expect(w).toContain('memory.querylog.jsonl') // 检索日志须随 sync 走白名单
    expect(w).toContain('memory-1.jsonl')
    expect(w.some((f) => f === 'emb.f32' || f === 'notes.txt')).toBe(false)
  })
})

describe('find_repo_walks_up', () => {
  it('data_dir 是仓内子目录时应找到外层仓；无仓时 undefined', () => {
    const d = tmp()
    const data = path.join(d, 'proj', 'memlite-data')
    fs.mkdirSync(data, { recursive: true })
    execFileSync('git', ['init', '-q', d])
    expect(findRepo(data)).toBe(d)
    // 无仓时 undefined
    const bare = tmp()
    expect(findRepo(bare)).toBeUndefined()
  })
})

describe('sync_commit_pathspec_and_verify', () => {
  it('commit 不卷走无关改动；push 后 ls-remote 核验 sha', async () => {
    const base = tmp()
    const remote = path.join(base, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const work = path.join(base, 'work')
    fs.mkdirSync(path.join(work, 'memlite-data'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', work])
    git(work, 'remote', 'add', 'origin', remote)
    git(work, 'config', 'user.email', 't@t')
    git(work, 'config', 'user.name', 't')
    fs.writeFileSync(path.join(work, 'README.md'), 'ws')
    git(work, 'add', 'README.md')
    git(work, 'commit', '-m', 'init')
    git(work, 'push', '-q', '-u', 'origin', 'main')

    const dataDir = path.join(work, 'memlite-data')
    fs.writeFileSync(path.join(dataDir, 'memory.jsonl'), '{"op":"put"}\n')
    fs.writeFileSync(path.join(dataDir, 'memory.querylog.jsonl'), '{"ts":1}\n')
    // 用户已暂存的无关改动——不应被卷进 memlite 的同步提交
    fs.writeFileSync(path.join(work, 'unrelated.txt'), 'user work')
    git(work, 'add', 'unrelated.txt')

    const report = await sync(dataDir)
    expect(report.verified).toBe(true)
    expect(report.committed).toBe(true)
    // 远端 sha 与本地一致（双通道核验）
    const ls = execFileSync('git', ['ls-remote', remote, 'refs/heads/main'], { encoding: 'utf8' })
    expect(ls.split(/\s+/)[0]).toBe(report.local_sha)
    // 白名单两文件都进了这次提交；unrelated 仍留在暂存区
    const committedFiles = git(work, 'show', '--name-only', '--format=', 'HEAD').split('\n')
    expect(committedFiles).toContain('memlite-data/memory.jsonl')
    expect(committedFiles).toContain('memlite-data/memory.querylog.jsonl')
    expect(committedFiles).not.toContain('unrelated.txt')
    expect(git(work, 'diff', '--cached', '--name-only')).toContain('unrelated.txt')
    // 第二次 sync：无新改动 → 不提交但核验仍过
    const report2 = await sync(dataDir)
    expect(report2.committed).toBe(false)
    expect(report2.verified).toBe(true)
  })
  it('无 origin 时报错指路', async () => {
    const d = tmp()
    execFileSync('git', ['init', '-q', d])
    await expect(sync(d)).rejects.toThrow('未配置 origin')
  })
  it('不在 git 仓内时报错指路', async () => {
    const d = tmp()
    await expect(sync(d)).rejects.toThrow('都不是 git 仓')
  })
})

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configSet,
  embeddingMerged,
  findProjectDir,
  homeDir,
  resolveDataDir,
  userDataDir,
  userConfigPath,
} from '../src/config'

const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-cfg-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function ctxOf(cwd: string, home: string, env: NodeJS.ProcessEnv = {}) {
  return { cwd, home, env }
}

describe('home_dir', () => {
  it('HOME → USERPROFILE → "."', () => {
    expect(homeDir({ env: { HOME: '/h', USERPROFILE: '/w' } })).toBe('/h')
    expect(homeDir({ env: { USERPROFILE: '/w' } })).toBe('/w')
    expect(homeDir({ env: {} })).toBe('.')
    expect(homeDir({ home: '/custom' })).toBe('/custom')
  })
})

describe('user_config_path', () => {
  it('MEMLITE_CONFIG 覆盖默认 ~/.memlite/config.json', () => {
    expect(userConfigPath({ env: {}, home: '/h' })).toBe(path.join('/h', '.memlite', 'config.json'))
    expect(userConfigPath({ env: { MEMLITE_CONFIG: '/x/c.json' }, home: '/h' })).toBe('/x/c.json')
  })
})

describe('find_project_dir', () => {
  it('从 cwd 向上找含 config.json 的 .memlite/ 或 memlite-data/', () => {
    const home = tmp()
    const workspace = tmp()
    const proj = path.join(workspace, 'memlite-data')
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, 'config.json'), '{}')
    const deep = path.join(workspace, 'a', 'b')
    fs.mkdirSync(deep, { recursive: true })
    expect(findProjectDir(ctxOf(deep, home))).toBe(proj)
    // git 根不越过：仓外层找不到就停
    const ws2 = tmp()
    fs.mkdirSync(path.join(ws2, 'sub'), { recursive: true })
    fs.mkdirSync(path.join(ws2, '.git'))
    expect(findProjectDir(ctxOf(path.join(ws2, 'sub'), home))).toBeUndefined()
  })
  it('用户级配置目录（~/.memlite）不误认成项目库', () => {
    const home = tmp()
    fs.mkdirSync(path.join(home, '.memlite'))
    fs.writeFileSync(path.join(home, '.memlite', 'config.json'), '{}')
    expect(findProjectDir(ctxOf(home, home))).toBeUndefined()
    // 但用户级 data_dir 仍可用
    expect(userDataDir({ env: {}, home })).toBe(path.join(home, 'memlite-data'))
  })
})

describe('resolve_data_dir', () => {
  it('CLI > MEMLITE_DATA > 工作区 > 用户级 > 默认', () => {
    const home = tmp()
    const workspace = tmp()
    const proj = path.join(workspace, '.memlite')
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, 'config.json'), '{}')
    expect(resolveDataDir('/cli', ctxOf(workspace, home))).toBe('/cli')
    expect(resolveDataDir(undefined, ctxOf(workspace, home))).toBe(proj)
  })
  it('env 覆盖工作区', () => {
    const home = tmp()
    const workspace = tmp()
    const proj = path.join(workspace, '.memlite')
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, 'config.json'), '{}')
    const c = ctxOf(workspace, home, { MEMLITE_DATA: '/env-dir' })
    expect(resolveDataDir(undefined, c)).toBe('/env-dir')
  })
  it('无工作区无 env → 用户级 data_dir → 默认 ~/memlite-data', () => {
    const home = tmp()
    fs.mkdirSync(path.join(home, '.memlite'), { recursive: true })
    fs.writeFileSync(
      userConfigPath({ env: {}, home }),
      JSON.stringify({ data_dir: '/user-dir' }),
    )
    expect(resolveDataDir(undefined, ctxOf(home, home))).toBe('/user-dir')
    const home2 = tmp()
    expect(resolveDataDir(undefined, ctxOf(home2, home2))).toBe(path.join(home2, 'memlite-data'))
  })
})

describe('embedding_merged', () => {
  it('用户级为底、项目级覆盖、env 最后覆盖', () => {
    const home = tmp()
    fs.mkdirSync(path.join(home, '.memlite'), { recursive: true })
    fs.writeFileSync(
      userConfigPath({ env: {}, home }),
      JSON.stringify({ embedding: { api_base: 'https://user', api_key: 'u-key', model: 'm1' } }),
    )
    const workspace = tmp()
    const proj = path.join(workspace, 'memlite-data')
    fs.mkdirSync(proj)
    fs.writeFileSync(
      path.join(proj, 'config.json'),
      JSON.stringify({ embedding: { api_base: 'https://proj', api_key: 'p-key' } }),
    )
    const c = ctxOf(workspace, home, { MEMLITE_EMBED_MODEL: 'm2' })
    expect(embeddingMerged(c)).toEqual({
      api_base: 'https://proj',
      api_key: 'p-key',
      model: 'm2',
    })
    // 无 env 时项目级覆盖用户级，model 继承用户级
    expect(embeddingMerged(ctxOf(workspace, home))).toEqual({
      api_base: 'https://proj',
      api_key: 'p-key',
      model: 'm1',
    })
  })
})

describe('config_set', () => {
  it('一层/两层 key 写用户级；data_dir 展开 ~/；--project 写项目级', () => {
    const home = tmp()
    const p1 = configSet('data_dir', '~/data', false, { env: {}, home })
    expect(p1).toBe(path.join(home, '.memlite', 'config.json'))
    const cfg = JSON.parse(fs.readFileSync(p1, 'utf8'))
    expect(cfg['data_dir']).toBe(`${home}/data`)
    const p2 = configSet('embedding.api_base', 'https://x', false, { env: {}, home })
    expect(p2).toBe(p1)
    const cfg2 = JSON.parse(fs.readFileSync(p2, 'utf8'))
    expect((cfg2['embedding'] as Record<string, unknown>)['api_base']).toBe('https://x')

    const workspace = tmp()
    const proj = path.join(workspace, 'memlite-data')
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, 'config.json'), '{}')
    const p3 = configSet('embedding.api_base', 'https://p', true, ctxOf(workspace, home))
    expect(p3).toBe(path.join(proj, 'config.json'))
    expect(
      (JSON.parse(fs.readFileSync(p3, 'utf8'))['embedding'] as Record<string, unknown>)['api_base'],
    ).toBe('https://p')

    // 三层 key 拒绝；无工作区写项目级报错
    expect(() => configSet('a.b.c', 'v', false, { env: {}, home })).toThrow(/一层或两层/)
    expect(() => configSet('k', 'v', true, ctxOf(home, home))).toThrow(/未识别到工作区记忆文件夹/)
  })
})

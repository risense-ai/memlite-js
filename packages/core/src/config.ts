/**
 * 配置分层：项目级（工作区记忆文件夹内 config.json）> 用户级（~/.memlite/config.json）。
 *
 * - data_dir：CLI flag > MEMLITE_DATA > 工作区记忆文件夹 > 用户级 data_dir > 默认
 * - embedding：env > 项目级 > 用户级（API 三件套写入默认落用户级——`config set` 不带 --project）
 * - 工作区记忆文件夹 = 从 cwd 向上找：`<dir>/.memlite/config.json` 或 `<dir>/memlite-data/config.json`，
 *   文件夹本身即 data_dir（项目级记忆与工作区同生共死，随工作区 git 一起同步）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MAX_LOCK_TIMEOUT_MS,
  MIN_LOCK_TIMEOUT_MS,
  type ConcurrencyConfig,
  type ConcurrencyMode,
  type FilesystemMode,
} from './lock'

/** 可注入的环境上下文（测试用；缺省取真实 process）。 */
export interface ConfigCtx {
  env?: NodeJS.ProcessEnv
  cwd?: string
  home?: string
}

function envOf(ctx?: ConfigCtx): NodeJS.ProcessEnv {
  return ctx?.env ?? process.env
}

/** 家目录：HOME（Linux/macOS）→ USERPROFILE（Windows）→ "." */
export function homeDir(ctx?: ConfigCtx): string {
  const env = envOf(ctx)
  if (ctx?.home !== undefined) return ctx.home
  return env['HOME'] ?? env['USERPROFILE'] ?? '.'
}

export function userConfigPath(ctx?: ConfigCtx): string {
  const env = envOf(ctx)
  const override = env['MEMLITE_CONFIG']
  if (override) return override
  return path.join(homeDir(ctx), '.memlite', 'config.json')
}

/** 读 JSON 配置；不存在或坏 JSON 返回 null。 */
export function loadConfig(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 从 cwd 向上找工作区记忆文件夹（含 config.json 的 .memlite/ 或 memlite-data/）。
 * 找到的第一个即项目级 data_dir——不跨出工作区继续上爬（git 根或文件系统根为界）。
 * 用户级配置目录（~/.memlite）与项目级同名，必须排除——否则家目录跑任何命令都会
 * 把用户配置误认成项目库（data_dir 错指 ~/.memlite）。 */
export function findProjectDir(ctx?: ConfigCtx): string | undefined {
  const userDir = path.dirname(userConfigPath(ctx))
  let cur = path.resolve(ctx?.cwd ?? process.cwd())
  for (;;) {
    for (const name of ['.memlite', 'memlite-data']) {
      const cand = path.join(cur, name)
      if (fs.statSync(path.join(cand, 'config.json'), { throwIfNoEntry: false })?.isFile()) {
        if (cand === userDir) continue // 用户级配置，不是项目库
        return cand
      }
    }
    // git 根不越过：工作区即仓库根
    const parent = path.dirname(cur)
    if (fs.existsSync(path.join(cur, '.git')) || parent === cur) return undefined
    cur = parent
  }
}

export function projectConfig(ctx?: ConfigCtx): [string | undefined, Record<string, unknown> | null] {
  const d = findProjectDir(ctx)
  if (!d) return [undefined, null]
  return [d, loadConfig(path.join(d, 'config.json'))]
}

/** 用户级 data_dir（不受项目级影响——两档回退的兜底目标） */
export function userDataDir(ctx?: ConfigCtx): string {
  const user = loadConfig(userConfigPath(ctx))
  const d = user?.['data_dir']
  if (typeof d === 'string' && d !== '') return d
  return path.join(homeDir(ctx), 'memlite-data')
}

/** data_dir 解析（四层） */
export function resolveDataDir(cli: string | undefined, ctx?: ConfigCtx): string {
  if (cli) return cli
  const envData = envOf(ctx)['MEMLITE_DATA']
  if (envData) return envData
  const proj = findProjectDir(ctx)
  if (proj) return proj
  return userDataDir(ctx)
}

/** embedding 合并：用户级为底、项目级覆盖、env 最后覆盖（操作者意图最优先） */
/** concurrency 合并：用户级为底、项目级覆盖；文件里用 snake_case，TS 侧归一为 camelCase。 */
export function concurrencyMerged(ctx?: ConfigCtx): ConcurrencyConfig {
  const user = loadConfig(userConfigPath(ctx))
  const [, proj] = projectConfig(ctx)
  const out: Record<string, unknown> = {}
  for (const src of [user?.['concurrency'], proj?.['concurrency']]) {
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      Object.assign(out, src as Record<string, unknown>)
    }
  }
  const cfg: ConcurrencyConfig = {}
  const mode = out['mode']
  if (typeof mode === 'string') cfg.mode = mode as ConcurrencyMode
  const filesystem = out['filesystem']
  if (typeof filesystem === 'string') cfg.filesystem = filesystem as FilesystemMode
  const timeout = out['lock_timeout_ms'] ?? out['lockTimeoutMs']
  if (typeof timeout === 'number') cfg.lockTimeoutMs = timeout
  return cfg
}

export function embeddingMerged(ctx?: ConfigCtx): Record<string, unknown> {
  const user = loadConfig(userConfigPath(ctx))
  const [, proj] = projectConfig(ctx)
  const out: Record<string, unknown> = {}
  for (const src of [user?.['embedding'], proj?.['embedding']]) {
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      Object.assign(out, src as Record<string, unknown>)
    }
  }
  const env = envOf(ctx)
  const apiBase = env['MEMLITE_API_BASE']
  if (apiBase) out['api_base'] = apiBase
  const apiKey = env['MEMLITE_API_KEY']
  if (apiKey) out['api_key'] = apiKey
  const model = env['MEMLITE_EMBED_MODEL']
  if (model) out['model'] = model
  return out
}

/** `memlite config set <key> <value>`——key 形如 data_dir / embedding.api_base；
 * 缺省写用户级（全局），`--project` 写项目级（须已识别到工作区记忆文件夹）。
 * 返回写入的配置文件路径。 */
export function configSet(key: string, value: string, project: boolean, ctx?: ConfigCtx): string {
  let p: string
  let cfg: Record<string, unknown>
  if (project) {
    const [dir, pc] = projectConfig(ctx)
    if (!dir) {
      throw new Error('未识别到工作区记忆文件夹（.memlite/ 或 memlite-data/ 含 config.json）')
    }
    p = path.join(dir, 'config.json')
    cfg = pc ?? {}
  } else {
    p = userConfigPath(ctx)
    cfg = loadConfig(p) ?? {}
  }
  const keys = key.split('.')
  if (keys.length === 1) {
    cfg[keys[0]] = valueInto(keys[0], value, ctx)
  } else if (keys.length === 2) {
    const [sec, field] = keys
    const sub = cfg[sec]
    if (!(sub && typeof sub === 'object' && !Array.isArray(sub))) cfg[sec] = {}
    ;(cfg[sec] as Record<string, unknown>)[field] = valueInto(`${sec}.${field}`, value, ctx)
  } else {
    throw new Error(`key 只支持一层或两层（如 embedding.api_base）: ${key}`)
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  atomicWriteText(p, JSON.stringify(cfg, null, 2))
  return p
}

function atomicWriteText(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

/** data_dir 展开 ~/；concurrency 枚举与超时做范围校验；其余按字符串存。 */
function valueInto(key: string, value: string, ctx?: ConfigCtx): string | number {
  if (key === 'data_dir') return shellexpandHome(value, homeDir(ctx))
  if (key === 'concurrency.mode') {
    if (value !== 'single-writer' && value !== 'multi-process') {
      throw new Error(`concurrency.mode 非法: ${value}（single-writer | multi-process）`)
    }
    return value
  }
  if (key === 'concurrency.filesystem') {
    if (value !== 'auto' && value !== 'local' && value !== 'nfs') {
      throw new Error(`concurrency.filesystem 非法: ${value}（auto | local | nfs）`)
    }
    return value
  }
  if (key === 'concurrency.lock_timeout_ms') {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < MIN_LOCK_TIMEOUT_MS || n > MAX_LOCK_TIMEOUT_MS) {
      throw new Error(
        `concurrency.lock_timeout_ms 须为 ${MIN_LOCK_TIMEOUT_MS}..${MAX_LOCK_TIMEOUT_MS} 的整数`,
      )
    }
    return n
  }
  return value
}

function shellexpandHome(v: string, home: string): string {
  if (v.startsWith('~/')) return `${home}/${v.slice(2)}`
  return v
}

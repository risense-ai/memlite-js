/** @rsrsai/memlite 公共出口——可嵌入本地记忆引擎，与 respire-memlite（Rust）数据互通。 */

// 存储层
export {
  Store,
  DATA_FILE,
  CHUNK_BYTES,
  parentId,
  importance,
  kind,
  nowTs,
  newId,
  serializeRecord,
  type MemRecord,
} from './store'

// 分词与检索
export { tokenize, isCjk } from './tokenize'
export { bm25, docTokens, defaultTitle, type Scored } from './bm25'
export { cosine, semantic } from './cosine'
export { rrfFuse } from './rrf'

// 向量侧车
export { VectorIndex } from './vectors'

// 因果树
export {
  TreeScope,
  renderTree,
  outline,
  treeJson,
  chainView,
  causalLines,
  PARENT_L1_CAP,
  type ChainView,
  type TreeNode,
} from './tree'

// 敏感闸
export { scan } from './sensitive'

// 配置
export {
  homeDir,
  userConfigPath,
  loadConfig,
  findProjectDir,
  projectConfig,
  userDataDir,
  resolveDataDir,
  embeddingMerged,
  configSet,
  type ConfigCtx,
} from './config'

// 检索日志
export { Log, appendLine, exportLog, LOG_FILE, type Entry, type Hit } from './querylog'

// 检索主流程
export { recallSearch, searchOnce, type RecallBackend, type SearchOnceOpts, type SearchOnceResult } from './recall'

// 同步
export { whitelisted, findRepo, status, sync, type SyncReport, type SyncStatus } from './sync'

// 嵌入档
export type {
  Embedder,
  EmbedderFactory,
  EmbedderDeps,
  EmbedOptions,
  EmbeddingProvider,
  ResolvedEmbeddingConfig,
} from './embedding/provider'
export { noneEmbedder } from './embedding/none'
export { makeOpenAIEmbedder, EmbedError } from './embedding/openai'
export { makeHostEmbedder } from './embedding/host'

// 主类
export { Memlite, memliteFromFiles, type MemliteConfig, type MemliteDeps, type RememberOpts, type RecallOpts, type RecallResult, type RecallHit } from './memlite'

// bench 评测
export { bench, CORPUS, type BenchResult, type CorpusItem } from './bench'

export const VERSION = '0.1.0'

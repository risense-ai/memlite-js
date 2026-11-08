/** @rsrsai/memlite 公共出口——可嵌入本地记忆引擎，与 respire-memlite（Rust）数据互通。 */

// 存储层
export {
  Store,
  StoreSnapshot,
  DATA_FILE,
  CHUNK_BYTES,
  META_FILE,
  STORAGE_PROTOCOL,
  REVISION_KEY,
  StaleVersionError,
  parentId,
  importance,
  kind,
  nowTs,
  newId,
  recordRevision,
  serializeRecord,
  type MemRecord,
  type StoreOptions,
  type StoreConcurrencyStatus,
  type TreeSource,
} from './store'

// 并发协议：跨进程锁、锁错误、文件系统检测与 NFS 探针
export {
  LockManager,
  ConcurrencyError,
  LockTimeoutError,
  LockUnsupportedError,
  SnapshotChangedError,
  DATA_LOCK,
  VECTOR_LOCK,
  LOG_LOCK,
  DEFAULT_LOCK_TIMEOUT_MS,
  MIN_LOCK_TIMEOUT_MS,
  MAX_LOCK_TIMEOUT_MS,
  resolveConcurrency,
  detectFilesystem,
  probeNfs,
  loadFsExt,
  resetFsExtCache,
  resetNfsProbeCache,
  type ConcurrencyConfig,
  type ConcurrencyMode,
  type FilesystemMode,
  type LockBackend,
  type LockKind,
  type LockMode,
  type ResolvedConcurrency,
  type FilesystemInfo,
  type NfsProbeResult,
} from './lock'

// 分词与检索
export { tokenize, isCjk } from './tokenize'
export { bm25, docTokens, defaultTitle, type Scored } from './bm25'
export { cosine, semantic } from './cosine'
export { rrfFuse } from './rrf'

// 向量侧车
export {
  VectorIndex,
  VectorCorruptError,
  VECTOR_F32,
  VECTOR_IDS,
  VECTOR_META,
  type VectorSnapshot,
  type VectorPutOptions,
  type VectorOptions,
} from './vectors'

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
  concurrencyMerged,
  configSet,
  type ConfigCtx,
} from './config'

// 检索日志
export { Log, appendLine, exportLog, LOG_FILE, type Entry, type Hit, type LogOptions } from './querylog'

// 检索主流程
export { recallSearch, searchOnce, type RecallBackend, type SearchOnceOpts, type SearchOnceResult } from './recall'

// 同步
export { whitelisted, findRepo, status, sync, type SyncReport, type SyncStatus, type SyncOptions } from './sync'

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
export { Memlite, memliteFromFiles, type MemliteConfig, type MemliteDeps, type RememberOpts, type RecallOpts, type RecallResult, type RecallHit, type WriteOptions } from './memlite'

// bench 评测
export { bench, CORPUS, type BenchResult, type CorpusItem } from './bench'

export const VERSION = '0.3.0'

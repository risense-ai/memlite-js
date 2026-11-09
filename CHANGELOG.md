# Changelog

## 0.3.1 (2026-11-09)

安装体验：原生锁 `fs-ext` 改为可选 peer 依赖。

- 发布包不再自动安装 `fs-ext`。此前它作为 `optionalDependencies` 会让 pnpm 触发依赖构建审批；
  非交互安装（如 DSH 插件管理器）会因 `ERR_PNPM_IGNORED_BUILDS` 判定失败并回滚，
  导致依赖本包的插件在编译不了原生模块的机器上装不上。
- 需要 `multi-process` 的调用方显式安装：`pnpm add fs-ext@^2.1.1`；未安装时 `single-writer`
  仍降级为进程内锁，`status().concurrency.lock_backend` 显示 `in-process`，`multi-process` 报 `LOCK_UNSUPPORTED`。
- CI 测试任务在安装后显式安装 `fs-ext` 以保留原生多进程测试；本地需要时手动 `pnpm add -w -D fs-ext@^2.1.1`。
  它不进发布清单，因此没有编译工具链的机器安装本包不会被原生构建卡住。
- 仓库根 `.npmrc` 设 `auto-install-peers=false`；缺原生锁时相关测试自动 skip，并新增一条「无原生锁时隔离探针回报不可用」用例。
- 无运行时行为、锁协议或数据格式变化。

## 0.3.0 (2026-11-08)

### 并发：多读单写与本地多进程

- 新增协作式跨进程文件锁：数据共享读/排他写、向量写锁、检索日志写锁；锁文件 `.memlite-data.lock` / `.memlite-vector.lock` / `.memlite-log.lock`
- 原生锁通过可选依赖 `fs-ext` 提供（Unix `flock`）；未安装时 `single-writer` 降级为进程内锁并在 `status()` 明示，`multi-process` 报 `LOCK_UNSUPPORTED`
- `Store` 全部写入口统一为“锁内重载 → 校验父/版本/防环/显式 id → 追加 → fsync → 轮转”；新增、更新、删除、改挂、`putFull` 不再绕过锁
- 读取新增 `Store.snapshot()` / `Memlite.snapshot()`：同一代次的不可变视图；recall/show/list/tree/chain/status 使用同一快照，因果视界不跨代拼装
- 压实使用随机临时文件名、先原子替换活跃文件再删归档；轮转在数据排他锁内；启动清理一小时前的本协议残留临时文件
- `sync` 在数据共享锁内冻结 git index；代次变化时重取或报 `SNAPSHOT_CHANGED`，不把未审核并发新增混入提交
- 新增 `concurrency.mode` / `concurrency.filesystem` / `concurrency.lock_timeout_ms` 配置；`configSet` 校验枚举与超时范围
- 新增 `meta.json` 的 `storage_protocol=1` 首次写入标记
- 新增 NFS 显式 opt-in 与隔离探针（锁、写后读、rename、fsync）；**真实 NFS 双客户端尚未验收，发布说明不宣称支持任意 NAS**
- 新增错误类型：`LockTimeoutError`（`LOCK_TIMEOUT`）、`LockUnsupportedError`（`LOCK_UNSUPPORTED`）、`SnapshotChangedError`（`SNAPSHOT_CHANGED`）、`VectorCorruptError`（`VECTOR_CORRUPT`）；扩展 `UNSUPPORTED_FILESYSTEM`、`NFS_PROBE_FAILED`
- 新增 15 例真实多进程测试：8 进程并发新增、同显式 id、同 revision 条件写、压实/轮转、快照读取、日志追加、向量并发、杀进程释放锁、超时与降级

### 向量

- `VectorIndex` 写入持向量排他锁，锁内重载 `emb.f32` / `emb-ids.txt` / 维度后再写
- 新增 `emb-meta.json` 记录向量对应的记忆 revision；嵌入返回后若记录已更新/删除，不覆盖向量，由 `reembed` 补齐
- 新增 `VectorIndex.snapshot()`，读取在共享锁内加载同一代次，释放后用不可变缓存计算
- `f32` 尾部崩溃残留可识别并在下一次写入时截断；id 数/维度/字节数不一致报 `VECTOR_CORRUPT` 并停止语义索引
- `reembed` 按 `batchSize` 分批，逐批受锁提交

### 兼容

- `status().vectors` 仍为数量；新增 `status().vector_status` 与 `status().concurrency`
- JSONL、BM25/RRF 常量、因果树字段不变；新增锁文件与 `emb-meta.json` 不影响 Rust 读取旧契约
- Rust 端锁协议尚未同步；同库运行期间不要让未升级的 Rust/旧版 JS 同时写

## 0.2.0 (2026-11-08)

### 条件写与版本守卫

- 新增 `extra.revision` 版本字段：新记录从 0 起，更新/改挂递增；Rust 侧 `serde(flatten)` 原样保留，JSONL 互通不破坏
- `recordRevision()`：旧数据无版本字段时以 `ts` 毫秒化作为稳定初值，避免同秒更新无法判冲突
- `Memlite.update/attach/forget` 接受 `{ expectedRevision }`：检查与追加在同一同步段完成，进程内并发不会静默覆盖
- 新增 `StaleVersionError`（`code='STALE_VERSION'`），直接暴露当前 revision 供 UI 展示与草稿保留
- `update` 返回值新增 `revision`，`attach` 返回值新增 `revision`

## 0.1.0 (2026-11-07)

首个版本。与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust）数据互通的核心库。

### 存储层

- `Store`：append-only JSONL + HashMap + LWW + 16MB 分块轮转 + 压实
- 行契约：`{"op":"put","id":12hex,"ts":...}` / del 墓碑；extra 平铺（parent_id/importance/kind）
- `resolve`：id / 纲名（精确标题唯一命中）/ 前缀 三级解析
- `versions` / `tagCounts` / `projectCounts` / `lineCount` / `fileStats`

### 检索层

- 中英混合分词：ASCII 整词小写；CJK 单字 + bigram；词界 U+4E00–U+9FFF
- BM25（k1=1.2, b=0.75, title×3），project 过滤
- 余弦语义 + RRF 融合（k=60，同 id 合并，同分 ts 新先）
- `recall` 主流程：BM25 必算 → 嵌入 → RRF；项目级无命中回退用户级；因果视界；querylog 落行
- bench：20 条真实形态记忆 × 20 改写型查询（移植 Rust 语料）

### 因果树

- `TreeScope`：trivial 出树、父失效提根
- 渲染（├─ └─ │ 竖线继承）/ outline 全深目录 / tree --json
- `chainView`：因链（根在前，64 层封顶）+ 果链下探
- `causalLines`：recall/show 因果视界行

### 向量侧车

- `VectorIndex`：emb.f32（packed f32 LE）+ emb-ids.txt；dim 自适应；原地覆盖；维度不符拒收

### 嵌入档

- `none`（默认纯 BM25）/ `host`（宿主注入）/ `openai-compatible`（fetch + AbortSignal.timeout）
- 密钥经 `credentialRef` 由宿主 credentials 注入，永不入本包
- 嵌入失败永不阻塞：recall 回退 BM25，remember 异步执行仅记日志
- `reembed` 批量回填

### 配置与同步

- 三层配置合并（env > 项目级 > 用户级）+ `data_dir` 四层解析 + `configSet`
- 用户级 `~/.memlite` 目录在项目级发现中排除（防误指）
- 敏感闸：PEM/JWT/token 前缀/明文口令/身份证/Luhn 银行卡/CN 手机号
- git 同步：白名单 add + pathspec commit（不卷走用户暂存）+ rebase --autostash + push + ls-remote 双通道 sha 核验

### 测试

- Rust 同名测试断言全量移植（store 14 / search 8 / tree 8 / sensitive 8 / vectors 3 / querylog 4 / sync 3 / config 6）
- 互通测试（`MEMLITE_RS_BIN` 提供 Rust 二进制时跑）：双向读写、排序一致、墓碑

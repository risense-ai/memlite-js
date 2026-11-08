# memlite-js 实施进度

> 从 [plan.md](./plan.md) 复制，逐项打勾追踪。开工日 2026-11-07。

## 里程碑总览

| 阶段 | 范围 | 估算 | 状态 |
|---|---|---|---|
| M1 | 核心库骨架 | 3 天 | ✅ 完成 |
| M2 | 因果树与配置 | 2 天 | ✅ 完成 |
| M3 | 向量侧车 + 检索主流程 | 2 天 | ✅ 完成 |
| M4 | 同步 | 1 天 | ✅ 完成 |
| M5 | 嵌入 provider | 2 天 | ✅ 完成 |
| M6 | 文档 + 发布 | 1 天 | ✅ 完成（GitHub 已发布；npm 暂缓——用户决定）|
| M7 | DSH 插件（独立仓库） | 下一阶段 | 不在本仓范围 |

---

## M1 核心库骨架（3 天）

### 仓库初始化
- [x] `pnpm-workspace.yaml`、`package.json`（根，private）（先前已建）
- [x] `.gitignore`（先前已建）
- [x] `packages/core/package.json`：name=`@rsrsai/memlite`，type=module，exports ESM+CJS（先前已建）
- [x] `tsup.config.ts`：esm + cjs + dts（先前已建）
- [x] `tsconfig.json`：strict、target ES2022、moduleResolution bundler
- [x] `vitest.config.ts`（先前已建）

### store.ts
- [x] `Record` 类型（op/id/ts/title/content/tags/project + flatten extra）
- [x] `Store.open(dataDir)`：扫描归档 + 活跃，LWW load
- [x] `put / putChild / putWithId / delete`
- [x] 16MB 轮转 + `compact`
- [x] `resolve`（id / 精确 title / id 前缀）
- [x] `versions(rid)` / `tagCounts` / `projectCounts` / `lineCount` / `fileStats`

### tokenize.ts
- [x] ASCII 整词小写
- [x] CJK 段单字 + bigram
- [x] 词界 U+4E00–U+9FFF（**不扩**）

### bm25.ts
- [x] `docTokens` = content + tags + title×3
- [x] k1=1.2, b=0.75，每查询重算 df/avgdl
- [x] project 过滤

### cosine.ts / rrf.ts
- [x] 余弦（零向量/长度不符返回 0）
- [x] RRF k=60，同 id 合并，同分 ts 新先

### 单测
- [x] `tokenize_mixed` / `tokenize_cjk_bigram_plus_unigram`
- [x] `bm25_finds_and_ranks` / `bm25_title_weight` / `bm25_project_filter`
- [x] `cosine_range_and_mismatch`
- [x] `rrf_fuse_dedup_and_both_lists_win`
- [x] `default_title_first_sentence`
- [x] store 全部 14 个测试（Rust 实有 14，非 11：put_get_delete_reload / empty_content_rejected / bad_line_tolerated / querylog_file_not_loaded / rotation_and_reload / tombstone_in_new_chunk / compact_collapses / short_id_prefix / resolve_by_exact_title / put_child_requires_parent / reparent_checked_blocks_cycle / update_put_with_id_preserves / children_sorted / ancestor_chain_survives_dirty）

---

## M2 因果树与配置（2 天）

### tree.ts
- [x] `TreeScope.build`：trivial 出树，父失效提根
- [x] `childrenOf` / `get` / `roots`
- [x] `renderTree`（├─ └─ │  竖线继承 next_prefix）
- [x] `ancestorChain`（根在前，64 层封顶）
- [x] `chain` 一把取回（chainView + outline + treeJson + causalLines 全套）
- [x] `reparentChecked` 防环（自挂 + 挂后代）

### config.ts
- [x] `homeDir` / `userConfigPath`（MEMLITE_CONFIG 覆盖）
- [x] `findProjectDir`：从 cwd 向上找，git 根不越过；排除 `~/.memlite`
- [x] `userDataDir` / `resolveDataDir`（四层）
- [x] `embeddingMerged`（env > 项目 > 用户）
- [x] `configSet`（一层/两层 key；shellexpand `~/`）

### sensitive.ts
- [x] PEM 私钥块
- [x] JWT（`eyJ` + base64url 两段）
- [x] token 前缀（`sk-`≥16 字母数字、`ghp_`/`gho_`/`github_pat_`、`AKIA`、`xox`）
- [x] 明文口令赋值式
- [x] 身份证 18 位 / 银行卡 16-19 位（Luhn）/ CN 手机号

### 单测
- [x] 树构建 / 渲染 / 防环 / 链封顶
- [x] 配置合并 / 项目发现 / 用户目录排除
- [x] 敏感扫描全部规则

---

## M3 向量侧车 + 检索主流程（2 天）

### vectors.ts
- [x] `VectorIndex.open`：读 emb-ids.txt + 推 dim
- [x] `get(rid)` / `put(rid, emb)`（append / overwrite）
- [x] cache 写前失效
- [x] 维度不一致拒收

### recall.ts
- [x] `recallSearch(dir, query, opts)`：BM25 必算 → 嵌入 → RRF
- [x] 项目级无命中回退用户级
- [x] 因果视界：命中渲染因链+果链
- [x] 写入 querylog（含 fallback、source、ms）

### querylog.ts
- [x] `Entry` 类型
- [x] `Log.load`：全文件扫聚合 counts，entries 只留末 50k 条
- [x] `appendLine`
- [x] `export({since})` 导出训练集

### 单测
- [x] 向量 roundtrip / 维度自适应 / 原地覆盖
- [x] recall 主流程：纯 BM25 / RRF / 嵌入失败回退
- [x] 项目级回退触发
- [x] querylog 写入与聚合

---

## M4 同步（1 天）

### sync.ts
- [x] `whitelisted(dataDir)`：`memory*.jsonl` / `meta.json` / `README.md`
- [x] `findRepo(dataDir)`：自身或向上找 `.git`
- [x] `status(dataDir)`：dirty / local_sha / has_remote
- [x] `sync(dataDir)`：白名单 add / pathspec commit / `pull --rebase --autostash` / push / `ls-remote` 双通道 sha 核验

### 集成测试
- [x] 临时 git 仓：whitelist 覆盖 querylog
- [x] findRepo 上爬
- [x] commit 不卷走无关改动（本地 bare remote 全链路 + 二次 sync 无提交仍核验）

---

## M5 嵌入 provider（2 天）

### embedding/provider.ts
- [x] `Embedder` 接口
- [x] `EmbeddingProvider` 类型
- [x] `EmbedderFactory` 钩子（注入 credentialResolver）

### embedding/none.ts
- [x] 空实现，调用方走 BM25

### embedding/openai.ts
- [x] fetch + AbortSignal.timeout
- [x] 错误分类（network / client / server / shape / timeout / credential）
- [x] 关键不变量：超时回退 BM25，永不 throw 阻塞 recall

### embedding/host.ts
- [x] 接口预留（`makeHostEmbedder`，由宿主注入）
- [x] 文档说明宿主如何实现

### reembed 工具
- [x] 给旧记忆批量回填向量（ts 升序、跳过已有）
- [x] 维度变更时拒收并计入 failed

### 单测
- [x] OpenAI provider mock fetch 三种响应（成功/4xx/5xx/形状不符/超时）
- [x] 超时回退
- [x] 嵌入失败 remember 仍成功

---

## M6 文档 + 发布（1 天）

- [x] README（npm 包用法 + 完整 API 表）——`packages/core/README.md`
- [x] `docs/compat.md` 完善（先前已落盘）
- [x] `docs/embedding.md` 完善（先前已落盘）
- [x] CHANGELOG（0.1.0 条目）
- [x] GitHub Actions（lint+typecheck / test 含 compat / build / npm publish on v* tag）——`.github/workflows/ci.yml`
- [x] 互通测试 `tests/compat.test.ts`：读 Rust 写的库 / 写 JS 给 Rust recall / 排序一致 / del 墓碑（`MEMLITE_RS_BIN` 未设时跳过）
- [x] 打 tag `v0.1.0`（注解 tag 已推送，GitHub release 已建）；**npm 发布暂缓**——用户决定（npm 账号不在本机）；CI publish 任务就绪，配 `NPM_TOKEN` secret 后重推 tag 即自动发布，或本机 `npm login` 后 `cd packages/core && npm publish --access public`

**GitHub 发布记录（2026-11-07）**：公开仓 https://github.com/risense-ai/memlite-js（main + tag v0.1.0 + release），CI 全绿。CI 调试三坑已修并留痕：① step 级 `if` 不支持 `secrets` 上下文（整个 workflow 秒拒、零 job）——经 `env` 传递判空；② `actions/checkout` 带 `repository:` 参数时不会检出本仓，须再补一个默认 checkout（否则 lock 文件缺失）；③ `pnpm/action-setup` 的 `version` 输入与根 package.json `packageManager` 字段冲突报 "Multiple versions of pnpm specified"——去掉 `version` 让其读 packageManager。sibling 仓 respire-memlite 为私有，CI 互通测试缺 PAT 时自动跳过（本地已实测互通）。

---

## 并发（0.3.0，2026-11-08）

- [x] M0 JS spike：`fs-ext` 编译与 flock 同进程/跨进程/退出释放/超时实测
- [x] M1 级别 0：数据共享读锁、排他写锁、快照代次、统一提交、压实/轮转、sync 锁内冻结 index
- [x] M2 级别 1：multi-process 写者队列、条件写锁内重读、向量锁与 revision manifest、日志锁
- [x] M3 JS 宿主接入：`Memlite.snapshot()`、异步嵌入写前复核、`reembed` 分批、状态输出
- [ ] M4 级别 2：NFS 显式配置与探针已实现；真实 NFS 双客户端验收未做
- [x] 测试：15 例真实多进程并发测试；全套 121 例（117 通过 + 4 例 Rust 互通按条件跳过）
- [ ] Rust 端锁协议与跨语言互通（`respire-memlite`）
- [ ] Windows 原生锁与打包验收

详见 [concurrency-progress.md](./concurrency-progress.md)。

## M7 DSH 插件（独立仓库，下一阶段）

不在本仓范围。M6 完成后启动 `risense/dsh-memlite`，依赖 `@rsrsai/memlite`。

---

## 附：实现备注（与 plan 的偏差）

1. **Memlite 主类**（`src/memlite.ts`）：proposal §6 契约要求 `new Memlite(config, deps)`，plan 模块清单没有对应文件——按 §6 新增；store/vectors/querylog 常驻内存（可嵌入定位），`recallSearch(dir,…)` 目录级入口保留给短进程场景。
2. **Deps.ctx 注入**：config 解析（dataDir/用户级回退目录）接受 `{env, cwd, home}` 注入，缺省取真实 process——测试可隔离。
3. **bench 语料**独立为 `src/bench-corpus.ts`（Rust CORPUS 20 条全量移植），`bench()` 默认纯 BM25 档，实测 hit@3 达标。
4. **互通测试**为条件测试：设 `MEMLITE_RS_BIN` 跑真互验（本机已用 respire-memlite 源码编译的二进制实测），CI 由上层 workflow 构建 sibling 仓并传入。

# memlite-js 实施计划

> 与 [proposal.md](./proposal.md) 配套。
> 总估算：**11 个工作日**。

---

## 里程碑总览

| 阶段 | 范围 | 估算 | 产出 |
|---|---|---|---|
| M1 | 核心库骨架 | 3 天 | Store + BM25 + 分词 + RRF + 单测 |
| M2 | 因果树与配置 | 2 天 | tree + config + sensitive + 单测 |
| M3 | 向量侧车 + 检索主流程 | 2 天 | vectors + recall + querylog |
| M4 | 同步 | 1 天 | sync + 集成测试 |
| M5 | 嵌入 provider | 2 天 | provider 抽象 + openai 实现 + reembed |
| M6 | 文档 + 发布 | 1 天 | README/CHANGELOG/CI/0.1.0 |
| M7 | DSH 插件（独立仓库） | 下一阶段 | 不在本仓范围 |

---

## M1 核心库骨架（3 天）

### 仓库初始化
- [ ] `pnpm-workspace.yaml`、`package.json`（根，private）
- [ ] `.gitignore`：node_modules / dist / *.tgz / .DS_Store
- [ ] `packages/core/package.json`：name=`@rsrsai/memlite`，type=module，exports ESM+CJS
- [ ] `tsup.config.ts`：esm + cjs + dts
- [ ] `tsconfig.json`：strict、target ES2022、moduleResolution bundler
- [ ] `vitest.config.ts`

### store.ts
- [ ] `Record` 类型（op/id/ts/title/content/tags/project + flatten extra）
- [ ] `Store.open(dataDir)`：扫描归档 + 活跃，LWW load
- [ ] `put / putChild / putWithId / delete`
- [ ] 16MB 轮转 + `compact`
- [ ] `resolve`（id / 精确 title / id 前缀）
- [ ] `versions(rid)` / `tagCounts` / `projectCounts` / `lineCount` / `fileStats`

### tokenize.ts
- [ ] ASCII 整词小写
- [ ] CJK 段单字 + bigram
- [ ] 词界 U+4E00–U+9FFF（**不扩**）

### bm25.ts
- [ ] `docTokens` = content + tags + title×3
- [ ] k1=1.2, b=0.75，每查询重算 df/avgdl
- [ ] project 过滤

### cosine.ts / rrf.ts
- [ ] 余弦（零向量/长度不符返回 0）
- [ ] RRF k=60，同 id 合并，同分 ts 新先

### 单测
移植 Rust 同名测试全部断言：
- [ ] `tokenize_mixed` / `tokenize_cjk_bigram_plus_unigram`
- [ ] `bm25_finds_and_ranks` / `bm25_title_weight` / `bm25_project_filter`
- [ ] `cosine_range_and_mismatch`
- [ ] `rrf_fuse_dedup_and_both_lists_win`
- [ ] `default_title_first_sentence`
- [ ] store 全部 11 个测试

---

## M2 因果树与配置（2 天）

### tree.ts
- [ ] `TreeScope.build`：trivial 出树，父失效提根
- [ ] `childrenOf` / `get` / `roots`
- [ ] `renderTree`（├─ └─ │  竖线继承 next_prefix）
- [ ] `ancestorChain`（根在前，64 层封顶）
- [ ] `chain` 一把取回
- [ ] `reparentChecked` 防环（自挂 + 挂后代）

### config.ts
- [ ] `homeDir` / `userConfigPath`（MEMLITE_CONFIG 覆盖）
- [ ] `findProjectDir`：从 cwd 向上找，git 根不越过；排除 `~/.memlite`
- [ ] `userDataDir` / `resolveDataDir`（四层）
- [ ] `embeddingMerged`（env > 项目 > 用户）
- [ ] `configSet`（一层/两层 key；shellexpand `~/`）

### sensitive.ts
- [ ] PEM 私钥块
- [ ] JWT（`eyJ` + base64url 两段）
- [ ] token 前缀（`sk-`≥16 字母数字、`ghp_`/`gho_`/`github_pat_`、`AKIA`、`xox`）
- [ ] 明文口令赋值式
- [ ] 身份证 18 位 / 银行卡 16-19 位（Luhn）/ CN 手机号

### 单测
- [ ] 树构建 / 渲染 / 防环 / 链封顶
- [ ] 配置合并 / 项目发现 / 用户目录排除
- [ ] 敏感扫描全部规则

---

## M3 向量侧车 + 检索主流程（2 天）

### vectors.ts
- [ ] `VectorIndex.open`：读 emb-ids.txt + 推 dim
- [ ] `get(rid)` / `put(rid, emb)`（append / overwrite）
- [ ] cache 写前失效
- [ ] 维度不一致拒收

### recall.ts
- [ ] `recallSearch(dir, query, opts)`：BM25 必算 → 嵌入 → RRF
- [ ] 项目级无命中回退用户级
- [ ] 因果视界：命中渲染因链+果链
- [ ] 写入 querylog（含 fallback、source、ms）

### querylog.ts
- [ ] `Entry` 类型
- [ ] `Log.load`：全文件扫聚合 counts，entries 只留末 50k 条
- [ ] `appendLine`
- [ ] `export({since})` 导出训练集

### 单测
- [ ] 向量 roundtrip / 维度自适应 / 原地覆盖
- [ ] recall 主流程：纯 BM25 / RRF / 嵌入失败回退
- [ ] 项目级回退触发
- [ ] querylog 写入与聚合

---

## M4 同步（1 天）

### sync.ts
- [ ] `whitelisted(dataDir)`：`memory*.jsonl` / `meta.json` / `README.md`
- [ ] `findRepo(dataDir)`：自身或向上找 `.git`
- [ ] `status(dataDir)`：dirty / local_sha / has_remote
- [ ] `sync(dataDir)`：
  - 只 add 白名单
  - commit 必带 pathspec（不卷走用户已暂存改动）
  - `pull --rebase --autostash`
  - push 后 `ls-remote` 双通道 sha 核验

### 集成测试
- [ ] 临时 git 仓：whitelist 覆盖 querylog
- [ ] findRepo 上爬
- [ ] commit 不卷走无关改动

---

## M5 嵌入 provider（2 天）

### embedding/provider.ts
- [ ] `Embedder` 接口
- [ ] `EmbeddingProvider` 类型
- [ ] `EmbedderFactory` 钩子（注入 credentialResolver）

### embedding/none.ts
- [ ] 空实现，调用方走 BM25

### embedding/openai.ts
- [ ] fetch + AbortSignal.timeout
- [ ] 错误分类（网络 / 4xx / 5xx / 响应形状不符）
- [ ] 关键不变量：超时回退 BM25，永不 throw 阻塞 recall

### embedding/host.ts
- [ ] 接口预留（由宿主注入）
- [ ] 文档说明宿主如何实现

### reembed 工具
- [ ] 给旧记忆批量回填向量
- [ ] 维度变更时拒收并提示

### 单测
- [ ] OpenAI provider mock fetch 三种响应
- [ ] 超时回退
- [ ] 嵌入失败 remember 仍成功

---

## M6 文档 + 发布（1 天）

- [ ] README（npm 包用法 + 完整 API 表）
- [ ] `docs/compat.md` 完善（已草拟）
- [ ] `docs/embedding.md` 完善（已草拟）
- [ ] CHANGELOG（0.1.0 条目）
- [ ] GitHub Actions：
  - lint + typecheck
  - test（含 compat）
  - build
  - npm publish on `v*` tag
- [ ] 打 tag `v0.1.0`，发布 `@rsrsai/memlite@0.1.0`

---

## M7 DSH 插件（独立仓库，下一阶段）

不在本仓范围。M6 完成后启动 `risense/dsh-memlite`，依赖 `@rsrsai/memlite`。

---

## 进度追踪

每完成一项打 `[x]`。M1 启动时把本文件复制为 `docs/plan-progress.md`，逐日更新。

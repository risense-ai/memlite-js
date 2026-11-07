# Changelog

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

# 与 Rust memlite 的互通契约

> 本文件列出**不可破坏**的数据契约。任何一版（Rust / JS）违反这些契约即视为 bug。

---

## 一、文件布局

```
data_dir/
├── memory.jsonl              # 活跃文件（追加式）
├── memory-0001.jsonl         # 归档（16MB 轮转）
├── memory-0002.jsonl
├── memory.querylog.jsonl     # 检索日志
├── meta.json                 # 预留
├── emb.f32                   # 向量 packed f32 LE（仅在启用嵌入时存在）
├── emb-ids.txt               # 向量 id 顺序对齐
└── .gitignore
```

---

## 二、`memory.jsonl` 行格式

### 2.1 put 行

```json
{"op":"put","id":"abc123def456","ts":1792078629.79,"title":"...","content":"...","tags":[],"project":"","parent_id":"","importance":"important","kind":"Context"}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | `"put"` | ✅ | |
| `id` | string | ✅ | 12 位 hex（uuid v4 simple 前 12 字符） |
| `ts` | number | ✅ | Unix 秒（含小数） |
| `title` | string | | 事实句标题；缺省截正文首句 ≤40 字 |
| `content` | string | ✅ | 正文 |
| `tags` | string[] | | 默认 `[]` |
| `project` | string | | 默认 `""` |
| `parent_id` | string | | 因父 id；空串=根 |
| `importance` | string | | `"important"` / `"trivial"`；缺省视 important |
| `kind` | string | | `Context` / `Task` / `Skill` / ... |
| 其他 | 任意 | | serde flatten 进 extra；JS 用 `Record<string, unknown>` 平铺接收 |

### 2.2 del 行

```json
{"op":"del","id":"abc123def456","ts":1792078629.79,"title":"","content":"","tags":[],"project":""}
```

墓碑。Load 时把 id 加入 deleted set，从 records 移除。

### 2.3 末写胜出（LWW）

- 加载顺序：归档按序号升序 → 活跃文件
- 同 id 后写覆盖先写
- del 后 put 复活；put 后 del 删除

### 2.4 轮转

- 活跃文件 ≥ 16 MB 时 `rename` 成 `memory-{seq:04}.jsonl`
- seq = 已有归档最大序号 + 1

---

## 三、向量侧车

### 3.1 `emb-ids.txt`

每行一个记忆 id，行号 = 该 id 向量在 `emb.f32` 中的下标。

```
abc123def456
xyz789qwe012
```

### 3.2 `emb.f32`

所有向量首尾相接的 f32 LE 字节流，无 header 无 magic。

```
[vec0_dim floats][vec1_dim floats]...
```

### 3.3 dim 自适应

读时 `dim = file_bytes / 4 / ids.len()`。首写定维，后续写入维度必须一致否则拒收。

### 3.4 同步

向量文件**不在** sync 白名单里——本机可重算（`reembed`），不入 git。

---

## 四、`config.json`

### 4.1 用户级 `~/.memlite/config.json`

```json
{
  "data_dir": "/path/to/memlite-data",
  "embedding": {
    "api_base": "https://api.siliconflow.cn/v1",
    "api_key": "sk-...",
    "model": "BAAI/bge-m3"
  }
}
```

### 4.2 项目级 `<workspace>/.memlite/config.json` 或 `<workspace>/memlite-data/config.json`

字段同用户级，覆盖合并。

### 4.3 env 覆盖

```
MEMLITE_DATA         → data_dir
MEMLITE_API_BASE     → embedding.api_base
MEMLITE_API_KEY      → embedding.api_key
MEMLITE_EMBED_MODEL  → embedding.model
MEMLITE_CONFIG       → 用户级 config.json 路径
MEMLITE_MODEL_DIR    → bge-m3 模型目录
MEMLITE_EMBED_THREADS → 嵌入推理线程数
```

### 4.4 优先级

```
env > 项目级 > 用户级 > 默认
```

**注意**：JS 版引入 `credentialRef` 替代直接存 apiKey 进 config.json——密钥存宿主 credentials，config.json 里只存引用名。这是**对 Rust 契约的扩展**而非破坏：JS 仍**读取** Rust 写的 apiKey 字段（向后兼容），但**写入**默认走 credentialRef。

---

## 五、检索算法常量

任何版本改动下列常量即破坏互通（同查询两版结果会不一致）：

| 常量 | 值 |
|---|---|
| BM25 k1 | 1.2 |
| BM25 b | 0.75 |
| title 权重 | ×3 |
| CJK 词界 | U+4E00–U+9FFF |
| RRF k | 60 |
| 因果链防环封顶 | 64 层 |
| querylog 尾窗 | 50_000 条 |

---

## 六、`memory.querylog.jsonl` 行格式

```json
{"ts":1792078629.79,"query":"...","backend":"semantic|bm25|rrf","limit":10,"fallback":"user|","source":"cli|web|dsh","ms":17,"hits":[{"id":"...","score":0.657,"title":"..."}]}
```

| 字段 | 说明 |
|---|---|
| `backend` | semantic / bm25 / rrf |
| `fallback` | 空=本库命中；"user"=项目级回退用户级 |
| `source` | cli / web / dsh / 其他宿主名 |
| `ms` | 端到端耗时（含回退那次） |

---

## 七、敏感闸规则

两版必须对同一段文本给出相同的拒入判定。当前规则集：

1. PEM 私钥块标记（`-----BEGIN` + `PRIVATE KEY`）
2. JWT（`eyJ` 开头 + base64url 两段）
3. token 前缀：`sk-`（后 ≥16 字母数字）、`ghp_`、`gho_`、`github_pat_`、`AKIA`、`xox`
4. 明文口令赋值式（`password: xxx`、`密码是xxx` 等）
5. 身份证 18 位（末位可 X）
6. 银行卡 16-19 位（**Luhn 校验**）
7. CN 手机号 1[3-9]xxxxxxxxx

新增规则时两版同步。

---

## 八、互通测试

`packages/core/tests/compat/`：

1. 用 Rust memlite 写库 → JS 读 + 命中
2. 用 JS 写库 → Rust `memlite recall` 命中
3. RRF 一致性：同查询两版返回顺序一致

CI 必跑。任何 PR 破坏互通即拒。

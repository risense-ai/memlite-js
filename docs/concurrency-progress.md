# memlite-js 并发实施进度

> 对应 [方案](./concurrency-proposal.md) 与 [计划](./concurrency-plan.md)。
> 记录日期：2026-11-08。设备：MacBook-Pro-5.local（macOS arm64，Node 24.18.0）。
> 范围：本次只交付 **memlite-js** 的级别 0/1；Rust 端 `respire-memlite` 尚未同步锁协议。

## 已交付

| 能力 | 状态 | 实现位置 |
|---|---|---|
| 数据共享读锁 / 排他写锁 | ✅ | `src/lock.ts`、`src/store.ts` |
| 向量排他锁、读取共享锁 | ✅ | `src/vectors.ts` |
| 日志追加排他锁 | ✅ | `src/querylog.ts` |
| 快照代次与锁内刷新 | ✅ | `Store.snapshot()` / `refreshLocked()` |
| 统一提交入口（锁内重载 + 父/版本/防环/唯一性校验） | ✅ | `Store.withWrite()` |
| 压实随机临时文件、先替换后删归档 | ✅ | `Store.compact()` |
| 轮转在数据排他锁内 | ✅ | `Store.maybeRotateLocked()` |
| `storage_protocol=1` 元数据 | ✅ | `Store.ensureProtocolMetaLocked()` |
| 条件写 revision 守卫 | ✅（0.2.0 已有，0.3.0 接入锁内重读） | `Store.putWithIdConditional()` 等 |
| 向量 revision manifest | ✅ 新增 `emb-meta.json` | `VectorIndex` |
| 嵌入计算移出数据锁、写前 revision 复核 | ✅ | `Memlite.embedRecord()` / `writeVectorIfCurrent()` |
| `reembed` 分批、逐批受锁提交 | ✅ | `Memlite.reembed()` |
| sync 锁内冻结 index、代次变化中止 | ✅ | `src/sync.ts` |
| 原生锁可选依赖 `fs-ext` | ✅（optional peerDependency；CI 测试任务显式安装，本地按需安装） | `package.json`、`.github/workflows/ci.yml` |
| 锁错误码 `LOCK_TIMEOUT` / `LOCK_UNSUPPORTED` / `SNAPSHOT_CHANGED` / `VECTOR_CORRUPT` | ✅ | `src/lock.ts`、`src/vectors.ts` |
| NFS 显式 opt-in、隔离探针 | ✅ 代码就绪；**未在真实 NFS 验收** | `probeNfs()` |
| 多真实进程测试 | ✅ 15 例 | `tests/concurrency.test.ts` |

## 实测证据

- `fs-ext@2.1.1` 在 Node 24.18.0 / macOS arm64 本机编译通过。
- 0.3.1 起 `fs-ext` 是可选 peer：发布包安装时不自动下载/构建；无编译工具链的机器上 pnpm 直接跳过，
  不再出现「未批准构建脚本」导致的安装失败与回滚；运行期 `loadFsExt()` 返回 `null` 并降级。
- CI 的测试任务在 `pnpm install` 之后显式安装 `fs-ext`（不进仓库清单），原生进程测试照常运行。
- `flock` 实测：同进程不同 fd 互斥、跨进程互斥、进程被 `SIGKILL` 后自动释放、非阻塞失败返回 `EAGAIN`。
- 8 个真实 Node 进程各写 10 条：80 条全部保留、无坏行、id 无重复。
- 同显式 id 并发新增：仅一个成功，另一个报 id 已存在。
- 同 revision 条件写：仅一个成功，另一个 `STALE_VERSION`。
- 压实/轮转与 60 条并发新增交错：最终 60 条完整。
- 写入期间两个读者持续取快照：`badLines=0`。
- 4 个进程并发追加日志 160 行：全部可解析。
- 4 个进程并发写向量 24 条：`emb.f32` 字节数、id 数、manifest revision 数一致，无尾部残留。
- 全套测试：`pnpm -C packages/core test` 121 例（117 通过 + 4 例 Rust 互通按条件跳过）；`pnpm -C packages/core build` ESM/CJS/d.ts 通过。

## 未完成 / 边界

1. **Rust 端未同步**：`respire-memlite` 的 `store.rs` 仍是单进程写；跨语言同库写入目前只在本机 JS 端验证，不能宣称两端锁互认。级别 1 的跨语言验收未完成。
2. **NFS 未实测**：没有真实 NFS 服务端与第二客户端；`filesystem=nfs` 会跑隔离探针，但发布说明不宣称“支持 NFS”，只标注实验性。
3. **Windows 未实测**：`fs-ext` 有 Windows flock 实现，但未在本项目验证；`multi-process` 在 Windows 上如原生锁加载失败会报 `LOCK_UNSUPPORTED`。
4. **缺少原生锁时的降级**：`single-writer` 会降级为进程内锁并在 `status().concurrency.lock_backend='in-process'` 明示；`multi-process` 仍拒绝。这不是跨进程保证。
5. **旧客户端混用**：advisory lock 不能阻止不遵守协议的旧版/外部脚本直接写 JSONL；`storage_protocol=1` 只能作为识别线索，不能绝对阻止。
6. **sync 时点语义**：add 在数据共享锁内冻结 git index；commit/rebase/push 在锁外进行。同步期间的新增不会混入本次 index，但也不会自动进入本次提交。
7. **目录 fsync**：已尽力调用，部分平台/文件系统不支持时静默跳过；未做断电级故障注入。

## 配置

```json
{
  "concurrency": {
    "mode": "single-writer",
    "filesystem": "local",
    "lock_timeout_ms": 10000
  }
}
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `concurrency.mode` | `single-writer` | `multi-process` 才允许多个协议写者 |
| `concurrency.filesystem` | `local` | `nfs` 显式开启探针；检测到网络盘但未开启时拒绝写入 |
| `concurrency.lock_timeout_ms` | `10000` | 100..120000 的整数 |

代码侧：

```ts
const mem = new Memlite({
  dataDir: '/path/to/data',
  concurrency: { mode: 'multi-process', lockTimeoutMs: 10_000 },
})
```

## 错误码扩展

方案列的六个错误码之外，新增两个实现扩展：

- `UNSUPPORTED_FILESYSTEM`：检测到网络盘但未显式配置 NFS。
- `NFS_PROBE_FAILED`：显式 NFS 模式的隔离探针未通过。

两者都带 `dataDir`、`operation`、`committed:false` 与建议动作，不含正文/凭据。

## 锁文件

```
data_dir/.memlite-data.lock     # 数据快照读写锁
data_dir/.memlite-vector.lock   # 向量写互斥锁
data_dir/.memlite-log.lock      # 检索日志写互斥锁
```

锁文件不进 git 白名单；`emb-meta.json` 也不进白名单（向量本机可重算）。

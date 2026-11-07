/** bench 语料：20 条真实形态记忆 × 20 改写型查询（移植自 Rust bench.rs CORPUS）。 */
export type CorpusItem = [title: string, content: string, query: string]

export const CORPUS: CorpusItem[] = [
  ['Python 3.12 发布新解释器', 'Python 3.12 正式发布，新解释器性能提升 10%，f-string 语法限制放宽', 'python 最新版出了什么'],
  ['nginx 反代超时排查', 'nginx 反向代理 upstream 504，最终是 proxy_read_timeout 默认 60s 太短，调到 300s 解决', '网关 504 超时怎么处理'],
  ['SQLite WAL 模式开启', 'SQLite 多进程读写冲突，开启 WAL journal_mode 后并发读不再互相阻塞', '数据库多进程读写冲突'],
  ['React 18 createRoot 迁移', 'React 18 迁移要把 ReactDOM.render 换成 createRoot，否则并发特性不生效', 'react 升级后渲染方式要改吗'],
  ['Docker 磁盘占满清理', 'docker system df 查看占用，prune -a 清理无容器引用的镜像，回收 20G', '容器磁盘满了怎么清理'],
  ['Git 合并保留两侧修改', 'git merge 冲突时用 git checkout --ours/--theirs 分别取本侧与对侧文件', '版本冲突两边代码都要怎么办'],
  ['Redis 内存持续增长', 'Redis 大 key 未设过期时间导致内存涨到 8G，用 scan 找出后逐个设置 ttl', '缓存内存一直涨不释放'],
  ['SSH 免密登录配置', 'ssh-keygen 生成密钥后 ssh-copy-id 追加到服务端 authorized_keys 即可免密', '每次登录都要输密码'],
  ['PostgreSQL 连接池耗尽', 'pgbouncer 配置 transaction 模式连接池，应用侧 max_connections 从 200 降到 50', '数据库连接数被打满'],
  ['Vim 批量替换文本', 'vim 里 %s/old/new/g 全文替换，先用 %s/old/new/gn 预览匹配数', '编辑器怎么全文查找替换'],
  ['CSS Grid 自适应布局', 'grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)) 实现免媒体查询的响应式', '不写媒体查询做自适应'],
  ['TypeScript 类型断言', 'TS 里 as const 把字面量收窄为精确类型，避免联合类型过宽', 'typescript 字面量类型收窄'],
  ['K8s Pod 一直 Pending', 'Pod Pending 是资源不足，describe 看 events 发现 CPU requests 超过节点可分配', '容器编排任务卡住不动'],
  ['Linux 查看端口占用', 'ss -tlnp 列出监听端口及进程，比 netstat 快且不用 root 看全', '哪个程序占了端口'],
  ['Rust 编译速度优化', 'cargo build 慢用 sccache 加速二次编译，workspace 拆分减少重复编译', 'rust 项目编译太慢'],
  ['Go goroutine 泄漏排查', 'pprof 的 goroutine profile 找到泄漏协程栈，根因是未关闭的 channel 消费者', 'golang 内存缓慢上涨'],
  ['Nginx HTTPS 证书更新', 'certbot renew 自动续期，nginx reload 后用 openssl s_client 验证新证书有效期', '证书到期怎么换'],
  ['MySQL 慢查询定位', 'slow_query_log 开启后用 mysqldumpslow 排序，发现缺索引的联合查询', '数据库查询很慢怎么查'],
  ['Terraform 状态文件锁', 'terraform state 锁定用 DynamoDB 避免两人同时 apply 互相覆盖', '基础设施并发操作冲突'],
  ['前端构建产物过大', 'vite 打包分析 vite-bundle-visualizer，发现某库被全量引入，改按需导入后减 400K', '打包体积太大怎么分析'],
]

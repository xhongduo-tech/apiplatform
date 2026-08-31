# 运行时安全边界

本文记录生产部署中会直接影响请求准入和首次管理员认领的安全默认值。更改这些
开关前应完成风险评估、容量压测并保留变更记录。

## 数据库与备份容器

Compose 中的 PostgreSQL 以镜像内置 UID/GID `70:70` 直接启动，不经过 root
入口或 `gosu` 降权；根文件系统只读、所有 Linux capabilities 均被删除，只有
数据卷与有限 tmpfs 可写。备份边车使用独立 shell 入口，不调用 `gosu`，根文件
系统同样只读，并且仅保留把快照分配给 backend 只读组所需的 `CAP_CHOWN`。

上述边界同时是上游镜像限时漏洞例外的补偿控制。例外仅绑定一个固定
RepoDigest，必须经独立复核、在发布证据中留存批准链接，并会在到期时自动阻断
检查。详情见 [SEC-2026-001](security-exceptions/SEC-2026-001-postgres-runtime.md)。
变更数据库用户、入口、镜像摘要、挂载权限或 capabilities 时，必须重新完成空卷
初始化、备份、恢复和漏洞可达性复核。

Redis 同样绕过镜像的 root 入口分支，直接以镜像内置 UID/GID `999:1000`
启动；根文件系统只读、capabilities 全部删除并启用 `no-new-privileges`，只有
持久化 `/data` 卷和有限 `/tmp` 可写。变更镜像 UID、AOF 参数或卷权限时，必须
执行写入、AOF 重写、容器重建和数据读取演练。可选 Sentinel overlay 的 replica
和三个 Sentinel 进程继承同一非 root/只读/零 capability 边界；replica 使用独立
持久卷，Sentinel 仅在有限 tmpfs 与各自的状态卷中写入。三个 Sentinel 分别把
选主状态与 configuration epoch 写入独立 `/data` 卷，避免全体进程重启后退回
最初 master。两个 Redis 节点启动时不会采用固定角色，而是要求至少 2/3
Sentinel 对 `(host, port, configuration epoch)` 连续三轮给出相同结论；无稳定多数
时失败关闭。一次性 quorum gate 还会确认多数状态、Sentinel quorum 与真实 master
角色后才允许 backend 冷启动。每个 Redis/Sentinel 都公告稳定的 Compose DNS 名，
避免容器和网络重建后把旧 IP 写回持久配置。

`REDIS_SENTINEL_PASSWORD` 在启用 overlay 时必须是独立非空高熵值，不能沿用
`REDIS_PASSWORD`；空值会在 Compose 渲染期被拒绝。持久状态包含 Redis/Sentinel
认证信息，卷权限限制为 Sentinel UID，且不得作为公开或未加密的诊断附件。为
安全更新持久配置，overlay 只接受字母、数字、下划线和连字符组成的 Redis 与
Sentinel 密码；README 推荐的十六进制随机值满足这一约束。

两个 Redis 数据卷与三个 Sentinel 状态卷必须作为同一个恢复集保留。丢失一个
Sentinel 状态卷可由其余 2/3 多数恢复；不得在保留任一 Redis 数据卷时同时删除或
重新初始化三个 Sentinel 状态卷，因为此时无法安全区分首次部署与故障转移后的
控制面丢失。完整控制面丢失必须按灾难恢复事件处理，而不是自动回退固定 master。

## 首次管理员认领

生产环境必须设置独立的 `ADMIN_BOOTSTRAP_TOKEN`。使用密码学安全随机数生成至少
32 个随机字节，例如：

```bash
openssl rand -hex 32
```

令牌仅用于首次设置管理员密码，初始化完成后不再参与登录。管理 UI 使用同源
`/api/admin/*` 请求；平台不会为管理端点返回跨源许可。通配 CORS 只覆盖使用
Bearer API Key 的 `/v1/*` 与 `/beta/v1/*` 公共中继端点。

初始化完成后，生产配置校验仍要求该变量存在，但认证逻辑不会再次接受它。应将
部署环境文件保持为仅所有者可读（例如权限 `0600`），不得把令牌复用于其他系统；
如需降低长期秘密复用风险，可把它轮换成一个新的、无其他用途的高熵退役值。
该值在管理员已认领的实例上不再具有认证能力。

初始化后可在「后台 → 管理员安全」轮换密码。修改必须再次提交当前密码；成功后
服务端递增管理员会话版本并立即拒绝此前签发的全部管理员 JWT，仅为当前请求签发
替换会话，同时写入不含密码内容的审计事件。共享管理员身份仍不等同于个人可追责
账号；需要多人管理、MFA 或单点登录时应在企业身份层实现并保留独立审计主体。

## 限流故障语义

Redis 是中继准入的安全依赖：

- 生产启动时 Redis 不可达会拒绝启动；
- Redis 直连、Sentinel 发现与 master 连接均设置连接/命令超时，整段 RPM+TPM
  准入还受 `RATE_LIMIT_ADMISSION_TIMEOUT_S` 总超时约束；
- 运行期间准入限流无法在总超时内完成时，中继返回 `503` 和 `Retry-After: 5`；
- Sentinel overlay 会把节点、master、Sentinel 密码和 DB 参数实际注入 backend，
  不是只启动旁路 Sentinel 容器；
- 已完成准入后的 Token 校正和返还是 best-effort，避免把已产生的正常响应改成
  失败；后续新请求仍会在 Redis 故障期间被拒绝。

如果 Redis 已原子接受一次准入写入、但响应在返回应用前丢失，服务端不会自动
重放这次不确定写入；相应 RPM/TPM 预留可能保守占用到分钟桶约 70 秒的过期时间，
期间会造成临时 `429`/`503`，但不会造成限额少计。这是限流完整性优先于短时可用性
的有界取舍。

客户端应对 `503` 使用带抖动的指数退避，不得无间隔重试。

发布或目标环境验收可运行 `bash scripts/test-sentinel-failover.sh`。它使用唯一的
临时 Compose project，主动停止该 project 的 Redis master，验证 replica 被提升
且可写，再等待 AOF 本地落盘、强制终止已晋升节点并验证重启后写入仍可读取，
随后同时强制重启三个 Sentinel 并验证其仍保留新 master 与 quorum；接着在不删
卷的前提下执行完整 `down`/`up` 以重建全部容器与网络，确认已确认写入、角色与
quorum gate 均保持正确，并再删除一个 Sentinel 状态卷验证 2/3 恢复，最后删除
演练卷。它不替代跨主机网络分区与机架故障演练。

TPM 预扣覆盖 prompt 与最大输出：Chat/Completions/Anthropic 识别 `max_tokens`
和 `max_completion_tokens`，Responses 识别 `max_output_tokens`，同时保守处理兼容
字段及 `n`/`best_of` 多候选。省略或伪造无效上限时使用
`RATE_LIMIT_DEFAULT_MAX_OUTPUT_TOKENS`，不能降为零。单请求预算超过该 Key TPM
时，即使分钟桶为空也直接返回 `429`。预留凭据绑定准入分钟桶；跨分钟完成或
失败只原子校正该原桶，并钳制到零，不会改写下一分钟其他请求的预算。

生产全局 `RATE_LIMIT_RPM` 与 `RATE_LIMIT_TPM` 必须大于零。单 Key 的 `-1`
不限流仍保留，但属于显式、可审计的管理员授权，不能通过把平台全局值设为零来
批量绕过。

## 配置解析与 TLS Cookie

显式提供但拼错的布尔、整数或浮点配置会在导入配置时直接失败，不会静默回落到
默认值。布尔值只接受 `true/false`、`1/0`、`yes/no` 或 `on/off`。启用夜间
不限流时，production preflight 还要求有效 IANA `PLATFORM_TIMEZONE` 和两个不同
的严格 `HH:MM` 起止时间。

Compose 的 `SESSION_COOKIE_SECURE=false` 只服务于默认的回环 HTTP 首次认领。
一旦把 `HTTP_BIND_ADDRESS` 从 `127.0.0.1` 扩大、通过域名提供服务或完成 TLS
接入，必须同时设置 `SESSION_COOKIE_SECURE=true`，并在可信代理终结 HTTPS；
不得以公网明文 HTTP 运行用户或管理员会话。

## 无限流量兼容开关

以下开关默认均为 `false`：

```dotenv
NIGHT_UNLIMITED_ENABLED=false
RATE_LIMIT_MODEL_EXEMPTIONS_ENABLED=false
```

前者会在配置的夜间时段完全跳过 RPM/TPM；后者会让 embedding 和 reranker
模型跳过 RPM/TPM。只有在相应算力池与其他工作负载物理或逻辑隔离、上游自身
具备容量保护，并且部署方接受滥用与成本风险时才应开启。更安全的常规做法是为
批处理使用独立 API Key 并设置经过压测的明确上限。

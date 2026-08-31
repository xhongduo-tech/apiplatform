# 运行时安全边界

本文记录生产部署中会直接影响请求准入和首次管理员认领的安全默认值。更改这些
开关前应完成风险评估、容量压测并保留变更记录。

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
且可写，最后删除演练卷；它不替代跨主机网络分区与机架故障演练。

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

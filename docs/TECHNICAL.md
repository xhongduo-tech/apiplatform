# Open API Platform 开放平台技术白皮书：面向内网/离线环境的大模型 API 网关

> **摘要** 本文档给出 Open API Platform（以下简称“平台”）的技术实现，覆盖架构、协议兼容、请求生命周期、限流、直连转发、多节点路由、计量记账与部署运维。生产部署必须显式注入独立的数据库、Redis 和 JWT 凭据。

---

## 目录

1. [引言](#1-引言)
2. [设计原则与目标](#2-设计原则与目标)
3. [系统架构](#3-系统架构)
4. [对外 API 兼容层](#4-对外-api-兼容层)
5. [一次请求的完整生命周期](#5-一次请求的完整生命周期)
6. [限流体系与夜间窗口](#6-限流体系与夜间窗口)
7. [过载治理：调度权归引擎](#7-过载治理调度权归引擎并发准入已整体移除)
8. [多节点路由](#8-多节点路由)
9. [计量、用量日志与成本估算](#9-计量用量日志与成本估算)
10. [数据模型](#10-数据模型)
11. [管理后台与用户控制台](#11-管理后台与用户控制台)
12. [配置体系：环境变量与运行时设置](#12-配置体系环境变量与运行时设置)
13. [部署与运维](#13-部署与运维)
14. [安全基线](#14-安全基线)
15. [测试、标定与验收方法](#15-测试标定与验收方法)
16. [相关工作的定位](#16-相关工作的定位)
17. [结论与未来工作](#17-结论与未来工作)
18. [附录](#18-附录)

---

## 1. 引言

### 1.1 背景与问题

大模型推理服务通常以兼容 OpenAI/A社 的 HTTP API 暴露。企业在内网或离线环境中需要一座“API 网关”来统一接入业务方（SDK、CC、Codex、内部系统），并在自掌控的 vLLM / llama.cpp 推理集群前完成鉴权、限流、路由、计量与审计。与传统 API 网关不同，该场景对以下特性高度敏感：

- **稳定性优先**：协调层（Redis、PostgreSQL）的任何抖动都不能放大为业务错误；
- **高并发长耗时**：单条请求持续数秒至数十秒，常规短连接网关的线程/连接模型不适用；
- **协议兼容**：必须同时支持 OpenAI（chat/completions、Responses、embeddings、rerank、images）与 A社 Messages；
- **安全启动**：开发环境可快速启动；生产环境必须显式注入独立的数据库、Redis 和 JWT 凭据。

### 1.2 平台定位

平台是一座**大模型 API 网关**：

```
Client ──► nginx ──► FastAPI 网关 ──► PostgreSQL（注册表/密钥/日志）
                          │
                          ├── Redis（限流计数，跨副本共享）
                          │
                          └── 推理节点集群（vLLM / llama.cpp，多节点轮询）
```

所有跨副本状态托管在 Redis，网关进程无状态，可水平扩展；PostgreSQL 仅承载持久化注册表与用量日志。

### 1.3 本文贡献

- 论证并实践了**「调度权归引擎」**的极简网关架构：网关只做限流、路由与如实转发，并发调度完全委托推理引擎的 continuous batching，过载可观测性由 TTFT 膨胀比结果信号承担；
- 设计了**原子预扣 + 事后校正 + 失败返还**的 TPM 限流算法，消除空桶 TOCTOU 竞态；预扣覆盖 prompt、最大输出和多候选放大，单请求超限直接拒绝；Redis 无法在总超时内确认准入状态时 fail-closed 返回可重试的 503；
- 提出**取消安全执行器 `guarded()`**，解决流式响应客户端断连时清理与计量丢失的问题；
- 给出可复现的测试、容量标定与故障演练方法；发行版不预置任何生产测量数据。

---

## 2. 设计原则与目标

| 原则 | 具体含义 | 实现位置 |
|---|---|---|
| **明确的故障边界** | 限流准入状态未知时返回可重试 503；响应后的计量校正与辅助熔断状态 best-effort | `policy.py`、`redis_client.py` |
| **调度权归引擎** | 网关不设并发上限、不排队、不预检；引擎的 continuous batching 是唯一调度器，过载状态如实透传 | `proxy/`（直连转发） |
| **预算不可绕过** | 参数别名、多候选与空桶均不能绕过 TPM；超大输入需缩短或申请明确限额 | `policy.py`、`token_estimate.py` |
| **奥卡姆剃刀** | 不在网关重复实现推理引擎已有的排队与 KV 准入，收敛为限流 + 轮询 + 如实转发 | 全局 |
| **安全配置** | 开发默认与生产凭据分离；生产缺少必需变量时拒绝启动 | `config.py`、`main.py` |
| **展示与管控同源** | 前端所有限额/状态数字来自后端实时下发，禁止硬编码 | `public.py`、前端 `gateway.ts` |

技术栈：后端 FastAPI（Python 3.11+，gunicorn + UvicornWorker）、PostgreSQL 16、Redis 7、httpx；前端 React 18 + Vite + Tailwind v3；nginx 反代静态资源与 SSE。

---

## 3. 系统架构

### 3.1 部署视图

```
                        ┌──────────────┐
   Client ────────────► │    nginx     │──┬─► /            前端静态（React SPA，双入口 index/admin）
  （SDK / CC   │  反代 / SSE  │  ├─► /api/*       管理/用户 REST（FastAPI）
   / Codex / curl）     └──────────────┘  └─► /v1/* /beta/* OpenAI/A社 兼容中继
                                                 │
                              ┌──────────────────┼───────────────────┐
                              ▼                  ▼                   ▼
                        PostgreSQL 16        Redis 7            推理节点集群
                      （注册表/密钥/日志） （限流计数，       （vLLM / llama.cpp，
                                            跨副本共享）        多节点轮询）
```

### 3.2 进程模型

容器 entrypoint 执行 `alembic upgrade head` 后，以 gunicorn 启动 `GUNICORN_WORKERS`（默认 4）个 UvicornWorker。每个 worker 内部运行：

- **UsageWriter**：内存队列 → bulk insert 异步批写用量日志；
- **OpsScheduler / UsageRetention**：可选运营日报与日志保留期清理。

跨 worker 状态只有限流窗口计数（Redis），网关无状态、可水平扩容。

### 3.3 组件总览

```
backend/
  app/
    main.py                 FastAPI 入口：lifespan 启停后台任务、错误格式适配、/health
    config.py               运行时配置（开发默认；生产凭据必须显式注入）
    auth.py                 API Key 哈希、强密码/PBKDF2、JWT 上下文、Cookie 会话与服务端撤销检查
    models.py               SQLAlchemy ORM + Pydantic schema
    database.py             engine / SessionLocal / init_db
    proxy/                  ── 中继面 ──
      chat.py               /v1/chat/completions（流式先探状态码、usage 注入）
      completions.py        /v1/completions
      embeddings.py         /v1/embeddings
      extra.py              /v1/rerank、/v1/images/generations、/v1/ocr
      responses.py          /v1/responses（Codex；Responses ⇄ OpenAI 双向转换 + 透传）
      anthropic.py          /v1/messages（A社 ⇄ OpenAI 双向转换 + 透传）
      beta.py               /beta/v1/chat/completions
      models.py             /v1/models 模型列表
      routing.py            端点解析、多节点轮询、虚拟模型解析、请求适配
      token_estimate.py     全格式 prompt token 估算（TPM 预扣 / count_tokens 共用）
      policy.py             单 Key 策略：IP/时段/RPM/TPM（原子预扣+校正+返还）+ 夜间不限流窗口
      db_bridge.py          代理热路径的 DB 桥接 + (authorization, model) TTL 缓存
      usage.py              usage 提取（chat / Responses 双格式）+ 成本估算
      client.py             全局 httpx AsyncClient（连接池 10k）
    redis_client.py         Redis 连接（Sentinel 可选，限流计数用）
    routers/                ── 管理/用户 REST ──
      admin.py              模型/密钥/申请/公告/Research/报告/迁移/用户管理
      admin_stats.py        管理端统计
      user.py               注册登录、自助统计/日志/密钥、社区论坛
      public.py             公开配置、模型列表、密钥申请、公告
    aioguard.py             取消安全执行器 guarded()（断流计量不丢失）
    usage_writer.py         用量日志异步批写（队列→bulk insert）
    ops_report.py / ops_scheduler.py   运营巡检报告
    migration_import.py     旧平台 CSV 导入
  alembic/versions/         001 基线 → 005 单 Key 限流列 → 006 用量日汇总（永久统计）
  tests/                    pytest 自动化测试套件
frontend/
  src/main.tsx              用户端入口（/）
  src/admin-main.tsx        管理后台入口（/admin.html）
  src/app/components/       页面与组件
  src/app/api/gateway.ts    REST 封装与类型
nginx/                      反代配置与前端构建镜像
scripts/calibrate.py        容量标定（测引擎准入参数的吞吐拐点）
dev.sh / build-offline.sh / deploy-offline.sh / docker-compose*.yml
```

### 3.4 生命周期管理

`main.py` 通过 `lifespan` 统一启停：

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(_startup_db_work)   # init_db + seed catalog
    await usage_writer.start()
    await ops_scheduler.start()
    await usage_retention.start()
    await asyncio.wait_for(redis.ping(), timeout=5)
    yield
    # shutdown：逆序 stop，并刷写 usage_writer 余量
    ...
```

### 3.5 健康检查

`GET /health` 返回：

```json
{"status": "ok|degraded", "db": true|false, "redis": true|false, "usage_dropped": 0}
```

仅 `db` 与 `redis` 均正常时为 `ok`（200），否则 `degraded`（503）。`usage_dropped` 反映 `UsageWriter` 因队列满而丢弃的日志条数。

---

## 4. 对外 API 兼容层

### 4.1 端点矩阵

| 端点 | 协议 | 实现文件 | 说明 |
|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat | `proxy/chat.py` | 流式/非流式，usage 注入 |
| `POST /v1/completions` | OpenAI Legacy | `proxy/completions.py` | FIM 代码补全 |
| `POST /v1/embeddings` | OpenAI Embeddings | `proxy/embeddings.py` | 向量化 |
| `POST /v1/responses` | OpenAI Responses | `proxy/responses.py` | Codex；上游 openai 格式时双向转换，anthropic/custom 维持透传 |
| `POST /v1/messages` | A社 Messages | `proxy/anthropic.py` | CC |
| `POST /v1/messages/count_tokens` | A社 | `proxy/anthropic.py` | 网关字符级估算 |
| `POST /v1/rerank` | 专有 | `proxy/extra.py` | 重排 |
| `POST /v1/images/generations` | OpenAI Images | `proxy/extra.py` | 文生图 |
| `POST /v1/ocr` | 专有 | `proxy/extra.py` | OCR，默认上游 `/recognize` |
| `GET /v1/models` / `/{id}` | OpenAI | `proxy/models.py` | 模型发现 |
| `POST /beta/v1/chat/completions` | OpenAI + 前缀续写 | `proxy/beta.py` | Beta 能力 |

鉴权头统一：`Authorization: Bearer sk-platform-xxx` 或 `x-api-key: sk-platform-xxx`，`normalize_client_auth` 归一化为 Bearer 形式。

### 4.2 虚拟模型

`platform-sota`、`platform-flash` 等是对外稳定别名。`resolve_model()` 在解析时：

1. 查找请求模型；
2. 若 `category == "lts"` 或 `resolve_to_model_id` 非空，则视为虚拟模型；
3. 校验对齐目标存在、状态可调用（`online|exclusive|unstable`）、部署配置完整（`base_url` 与 `model_api_name`）；
4. 返回真实模型，并在响应头 `X-Resolved-Model` 中告知客户端实际命中模型。

### 4.3 A社 适配（/v1/messages）

按模型 `import_format` 走两条路径：

**路径 1：anthropic / custom 上游 → 直接透传**

- 请求体原样转发（含 SSE），最贴合 CC 工具往返；
- 流式旁路解析 `message_start.usage.input_tokens` 与 `message_delta.usage.output_tokens` 完成计量。

**路径 2：openai 上游 → 双向转换**

请求转换 `anthropic_to_openai`。除字段映射外，核心职责是把任意客户端输入**规整为
上游 chat template 必定接受的合法消息序列**（首位角色/相邻关系合法）：

- **system 置顶合并**：顶层 `system` 参数与混入 `messages` 的 `role=system` 消息合并为唯一一条置于消息列表首位（多数 vLLM chat template 只接受 system 开头，否则 400 “System message must be the beginning”；置顶后次位即 user，同时满足“对话以 user 开始”的模板约束）；
- **tool_result 先于用户文本**：同一 user 回合中 tool 结果消息先输出（OpenAI 语义要求 `role=tool` 紧跟携带 `tool_calls` 的 assistant 消息）；
- **孤立 tool_result 降级**：历史被截断、前面没有对应 assistant `tool_calls` 时，tool 结果降级为 user 文本（`[工具结果] ...`），避免 `role=tool` 打头被上游 400；
- **思考块丢弃**：`thinking` / `redacted_thinking` 不回传上游（OpenAI 协议无对应物）；仅含思考块的 assistant 回合整体丢弃，不产生 `{"content": null}` 且无 `tool_calls` 的非法消息；
- **非标准角色钳制**：`tool`/`function` 等未知角色的字符串消息钳制为 `user`；
- content blocks（text/image/tool_use/tool_result）、tools/tool_choice 全量映射。

响应转换：

- 非流式：`openai_to_anthropic` 完整转换；
- 流式：OpenAI SSE → A社 SSE 转换，文本逐块 emit `content_block_delta`，工具调用累积后 emit `tool_use` 块与 `input_json_delta` 增量。

**计量**：转换路径流式请求强制注入 `stream_options.include_usage`，从上游末块 usage 提取真实 token；纯 usage 块只被网关消费，不回传客户端。

### 4.4 错误格式整形

`main.py` 统一异常处理，使错误体符合客户端 SDK 预期：

- `/v1/messages*` → A社 风格 `{"type":"error","error":{"type","message"}}`
- 其余 `/v1/*`、`/beta/*` → OpenAI 风格 `{"error":{"message","type","code"}}`
- `/api/*` 管理面保持 FastAPI 默认 `{"detail":...}`

`429 → rate_limit_error`、`503 → overloaded_error` 等 type 映射保证 SDK 正确执行重试/退避语义。

### 4.5 上下文超限的处理：如实转发，交由上游判定

> **设计说明**：平台不会在网关层压缩、改写或自动续写调用方输入，也不基于字符估算提前拒绝边界请求。上下文上限由上游引擎按其真实 tokenizer 与部署配置判断，避免网关维护一套易失真的重复配置。

现行方案：**网关对请求内容不做任何压缩、截断、改写或预检**，原样转发；输入超限时由上游模型直接报错，网关如实透传其状态码与错误信息。同一模型的多档位上下文分流（按 `context_window` 选档路由）亦已一并移除——同一模型请统一按最大所需上下文部署。

---

## 5. 一次请求的完整生命周期

以 `POST /v1/chat/completions` 为例，请求按以下阶段处理：

```
① 鉴权 + 模型解析      prepare_proxy_request：
   （db_bridge）         (authorization, model) 进程内 TTL 缓存，默认 3s
② 策略校验             policy.enforce_pre：
   （policy）            Key 状态与模型权限 → RPM → TPM 原子预扣（夜间窗口内跳过限流）
③ 选节点               pick_upstream（多节点进程内轮询）
   （routing）
④ 转发                 httpx 全局连接池直达引擎；流式先建连探状态码，
                        2xx 才提交 SSE 响应
⑤ 计量记账             usage 提取 → usage_writer 异步批写 usage_logs；
                        TPM 按实际用量校正差额；失败请求返还预扣（取消安全）
```

### 5.1 热路径鉴权缓存

`prepare_proxy_request()` 在 `db_bridge.py` 中实现。由于每道中继请求都要校验 API Key 与解析模型，若每次都查 PG，线程池（默认 32 线程）会成为吞吐瓶颈。因此引入 `(authorization, model)` 维度的进程内 TTL 缓存：

- `AUTH_CACHE_TTL_S = 3`（命中时零 PG 往返；设为 0 关闭）；
- 校验失败（401/403/404/503）同样缓存，防止无效 key 打穿；
- 缓存上限 8192 条，超出时整体清空；
- admin 侧修改 key/模型后可通过 `invalidate_prepare_cache()` 即时生效。

```python
async def prepare_proxy_request(authorization, requested):
    if AUTH_CACHE_TTL_S > 0:
        hit = _prep_cache.get((authorization, requested))
        if hit and not expired: return unwrap(hit)
    result = await asyncio.to_thread(_prepare_and_fill, authorization, requested)
    return unwrap(result)
```

### 5.2 策略校验（详见 §6）

`policy.enforce_pre()` 执行 RPM → TPM 预扣（夜间不限流窗口内跳过）。返回与 `int` 兼容、同时绑定准入分钟桶的 `TokenReservation`，调用方最终原样传给 `record_tokens()` / `refund_tokens()`；跨分钟完成仍只校正原桶。

### 5.3 节点选择与转发（详见 §8）

`pick_upstream()` 在 `extra.endpoints[]` 的有效节点间进程内轮询选择具体节点，构造 URL 与 headers，通过全局 httpx 客户端转发。

### 5.5 计量与释放

非流式在收到完整响应后提取 `usage`；流式在 `_pump()` 生成器的 `finally` 中汇总 usage。所有清理操作（关闭上游连接、记录用量、校正 TPM、记录延迟）均经 `guarded()` 包裹，防止客户端断连导致清理丢失。

### 5.5 流式先探状态码

流式请求先建立上游连接并检查状态码，确认 2xx 后才提交 `StreamingResponse`；上游 4xx/5xx 以真实状态码返回 JSONResponse，让客户端能识别错误并停止重试，而不是收到 HTTP 200 + 空 SSE 流。

---

## 6. 限流体系与夜间窗口

对每个 API Key 生效 RPM/TPM 定窗计数，经 Redis 跨副本一致。Redis 连接/命令与整段准入均有超时；无法确认时返回 `503` 与 `Retry-After: 5`。生产全局 RPM/TPM 必须大于零（单 Key `-1` 不限流是独立的显式授权）。夜间不限流安全默认关闭；启用时 production preflight 强制校验 IANA 时区与严格 `HH:MM` 起止时间。embedding/reranker 的模型豁免同样默认关闭。

| 机制 | 违规响应 |
|---|---|
| RPM / TPM 每分钟定窗计数（夜间窗口内跳过） | 429 + `Retry-After` |

### 6.1 RPM 定窗计数

每分钟一个窗口，Redis key 为 `rl:rpm:{key_id}:{bucket}`，其中 `bucket = floor(unix_time / 60)`。

```python
pipe.incr(rk)
pipe.expire(rk, 70)
n = (await pipe.execute())[0]
if n > rpm_limit:
    retry = 60 - (time.time() % 60)
    raise 429(headers={"Retry-After": retry})
```

`INCR` 与 `EXPIRE` 走同一 pipeline，避免 EXPIRE 单独失败留下无 TTL 的泄漏键。

### 6.2 TPM：原子预扣 + 事后校正 + 失败返还

设 `C_tpm` 为单 Key 的 TPM 上限（key.tpm_limit 或平台默认 6,000,000），`est = prompt_estimate + max_output × max(n, best_of, 1)`。最大输出覆盖 Chat/Completions/Responses/Anthropic 及兼容别名；省略或非法值使用安全默认。

**步骤 1：原子预扣**

```python
if est > C_tpm:                # 写桶前拒绝，空桶不例外
    raise 429(...)
n = redis.incrby(tk, est)      # tk = rl:tpm:{key_id}:{bucket}
redis.expire(tk, 70)
before = n - est
if before >= C_tpm or n > C_tpm:
    atomic_clamped_adjust(tk, -est)
    raise 429(...)
reserved = TokenReservation(est, bucket)
```

- 先 `INCRBY` 再判定，消除“多个大请求同时读到空桶全部放行”的 TOCTOU 竞态；
- **空桶同样受限**：单请求预算大于 TPM 时不会写入 Redis，也不会消耗 RPM；客户端必须降低最大输出、缩短输入或使用经审批的更高限额。

**步骤 2：事后校正**

响应完成后按实际 `total_tokens` 补差额：

```python
delta = total_tokens - reserved
atomic_clamped_adjust(original_bucket_key, delta)
```

未拿到实际用量（流中断等）时不做校正——预扣值即作为记账，宁可略多计。

**步骤 3：失败返还**

若请求在产生上游消耗之前失败（连接失败 / 上游 4xx 且无 usage），归还预扣：

```python
atomic_clamped_adjust(original_bucket_key, -reserved)
```

Lua 原子校正确保计数永不为负；原桶已过期时返还是 no-op，绝不扣减当前分钟桶。校正与返还均经 `guarded()` 执行，保证取消安全。

### 6.3 单 Key 覆盖与并发档位

> 本节讲**实现**。三档的定位（为什么它只是速率闸门、不是容量承诺）与升档的运营闭环，见 [scheduling.md「并发档位」](./scheduling.md)。

单 Key 的 `rpm_limit` / `tpm_limit`（`policy.effective_rate_limits`）三态语义：

| 字段值 | 生效限额 | 含义 |
|---|---|---|
| `None` | `settings.RATE_LIMIT_RPM/TPM` | 平台默认 |
| `-1`（负数） | `0`（策略层跳过检查） | **无限**（超高并发，不限流） |
| `> 0` | 该值 | 自定义上调/下调 |

RPM 与 TPM **各自独立取值**，允许混档（如「RPM 无限 + TPM 限额」，适合少量超大请求的用户）。管理端弹窗的两个「无限」开关因此也是分开的——表单状态空间必须能覆盖库的状态空间，否则打开-保存一次就会把混档压扁成两个 `-1`，静默放开限制。

**写入层拒绝 `0`**（`admin.normalize_rate_limit`，422）：`0` 在策略层表示「无限」，若写入层把它当成「回落默认」，按策略层语义传 `0` 的脚本会被静默降级为平台默认限流。同一个数字不能在两层有两种含义——要无限传 `-1`，要默认留空。同理 `rpm_limit`（int4）/`tpm_limit`（int8，迁移 010 放宽）超界也在入口报 422，不留到 commit 变 500。`settings.rate_limit_presets()` 下发的 `rpm/tpm` 一律用写入层语义（无限档为 `-1`），可直接作为 `/limits` 入参。

管理员在“后台 → 密钥管理 → 并发”弹窗操作：
- **一键档位**：平台默认 / 高并发（`RATE_LIMIT_HIGH_RPM/TPM`）/ 超高并发（无限）——预设数值由后端 `settings.rate_limit_presets()` 集中下发（`/api/public/config`），前端不硬编码；
- **自定义**：直接填 RPM/TPM，两项可分别设无限，或留空回落默认；
- **套用到用户全部密钥**：`apply_to_user_keys=true` 时同步套用到该账号 ID名下所有有效密钥；
- 保存即时生效（`/limits` 端点写库后 `invalidate_prepare_cache()`，不等鉴权缓存 TTL）。

密钥列表按 `matchPreset()` 反查档位名（与弹窗高亮同一份判定），命中显示档位、未命中显示「自定义」，副行给出具体数值；CSV 导出含「档位」列，便于盘点谁已升档。

**用量页速率面板**：对「无限」Key 不画进度条，展示实时用量 + 「无限」标记。**夜间不限流窗口内**（`/api/user/rate-limits` 返回 `night_unlimited`）不展示数值，改标注「不限流」并说明窗口内不做速率计数——`enforce_pre` 在窗口内直接早退，连计数键都不写，此时 `used` 恒为 0，若照常画「0 / 600」会被误读成「我夜间没有调用」。该布尔值必须由服务端判定（窗口按 `PLATFORM_TIMEZONE` 计算），前端拿 `start/end` 自行推算会因浏览器时区不同而错判。

---

## 7. 过载治理：调度权归引擎（并发准入已整体移除）

> **设计说明**：vLLM/SGLang 的 continuous batching 已负责并发上限、内部队列、KV 准入与抢占，并且掌握真实显存水位。网关不再叠加一层重复的计数准入，以避免双重排队和观测指标失真。

### 7.1 现行行为

- 请求经三层限流（§6）后**直达推理引擎**，网关不设并发上限、不排队、不预检；
- 引擎过载的表现（TTFT 上升、引擎内排队、极端时拒绝或断连）**如实透传**给客户端；
- 极端过载下客户端等到 `UPSTREAM_READ_TIMEOUT_S`（默认 600s）或收到连接错误——过载语义完全由引擎表达，网关不代为兜底；
- 引擎侧准入参数（vLLM `--max-num-seqs` / SGLang `--max-running-requests`）在部署时按显存与目标上下文设定，宁低勿高（偏高会 KV 抢占抖动伤所有人 TTFT）。

### 7.2 过载可观测性

网关对引擎饱和的唯一可见信号是 **TTFT 膨胀**（流式请求的 `latency_ms` 记录 TTFT；引擎积压的征兆是陡增，分时稀释是渐进）。运营日报按模型×小时聚合时延中位数，高峰/低谷膨胀比 ≥ `OPS_SATURATION_INFLATION_WARN`（默认 4 倍）时产出 `saturation_suspect` 告警，处置动作：扩节点、收紧引擎准入参数、或引导高峰大户错峰/夜间批量（§15.2）。

### 7.3 取消安全：aioguard（保留）

客户端提前断开流式响应时，starlette 的 level-cancellation 会取消生成器，`finally` 中的每个 `await` 都会再次抛出 `CancelledError`，导致用量记账整段丢失。

`aioguard.guarded(coro, what)` 把清理协程放入独立 task，再尝试 `await asyncio.shield(task)`：

- 正常路径：内联等待，语义与直接 `await` 一致；
- 已取消作用域：`await shield` 被取消，但独立 task 继续在后台完成，清理绝不丢失。

关键清理（`policy.record_tokens`、`policy.refund_tokens`、流式 finally 中的 `r.aclose()`）均经 `guarded()` 执行。

---

## 8. 多节点路由

### 8.1 多节点轮询

模型可在 `extra.endpoints[]` 配置多节点。选择逻辑 `pick_upstream()` 为进程内轮询：依次分发到各有效端点，负载均匀摊开且零额外 IO。

```python
def pick_upstream(model):
    valid = _valid_endpoints(model)
    if not valid: return model.base_url, 0
    return _pick_round_robin(model.id, valid)
```

### 8.2 Token 预扣估算（`token_estimate.py`）

Prompt 估算用于 TPM 原子预扣与 `/v1/messages/count_tokens`；生成型入口再加最大输出预算，并据此执行单请求 TPM 拒绝。无需 tokenizer，字符级快速估算（大请求移出事件循环）：

- 中文（CJK）1 字符 ≈ 1 token；
- 其他字符 3.5 字符 ≈ 1 token（向上取整）；
- 内联 base64 图片按 1024 token；
- 图片 content part 类型 `image/image_url/input_image` 按 1024 token；
- 工具定义按 JSON 全文计；
- 每条消息额外加 4 token 结构开销。

输出预算识别 `max_tokens`、`max_completion_tokens`、`max_output_tokens` 及兼容字段；冲突别名取最大值，`n`/`best_of` 取最大候选倍率，缺失或非法值回落 `RATE_LIMIT_DEFAULT_MAX_OUTPUT_TOKENS`。

覆盖全部请求格式：messages/system/prompt/input/instructions、tools 定义（JSON 全文）、assistant tool_calls 参数、多模态内容、rerank 的 query/documents。

---

## 9. 计量、用量日志与成本估算

### 9.1 Usage 提取

`usage.py` 兼容三种命名：

- OpenAI chat：`prompt_tokens` / `completion_tokens` / `total_tokens`；
- Responses / A社：`input_tokens` / `output_tokens` / `total_tokens`；
- DeepSeek 风格的上下文缓存命中指标（`prompt_cache_hit_tokens` 等）透传落库。

### 9.2 流式计量补齐

vLLM 仅在 `stream_options.include_usage` 开启时于末块回报 usage。客户端未主动要求时由网关注入，产生的纯 usage 块不回传客户端（chat 直通与 A社 转换路径同样处理）。Responses 透传流式则旁路逐行解析 `response.completed` 事件。

### 9.3 异步批写

`UsageWriter`：

- 内存队列上限 10,000 条；
- 每 2 秒或攒满 200 条 bulk insert；
- 队列满时丢弃并计数（`/health` 暴露 `usage_dropped`），热路径永不阻塞；
- shutdown 时余量刷写，最多等待 5 秒。

### 9.4 成本估算

模型可配 `pricing_input/output`（¥/百万 token）：

```python
cost = round((prompt_tokens * pin + completion_tokens * pout) / 1_000_000, 6)
```

### 9.5 用量日志字段

`usage_logs` 表记录：key / 模型 / 状态码 / prompt·completion·total tokens / 缓存命中指标 / TTFT（`latency_ms`）/ 总时长（`total_duration_ms`）/ 错误详情（4xx/5xx 截断 1000 字符）/ 响应预览（成功与失败均采集，截断 500 字符；流式只取正文文本开头）/ 估算成本。

### 9.6 保留期

`usage_retention` 按 `USAGE_LOG_RETENTION_DAYS = 90` 定期清理 `usage_logs` 明细（错误详情、响应预览等排查字段）。

调用次数 / Token 等统计数据不受此清理影响：`usage_writer` 在写入明细的同时，原子递增
`usage_daily_summary`（按 天 + API Key + 模型 汇总的永久表）；`/user/stats/*` 系列接口
一律从该表聚合，即使 Key 已被用户删除（软删除，`api_keys` 行仍保留）或调用发生在保留期
之前，统计数据依然完整。

---

## 10. 数据模型

| 表 | 关键字段 | 说明 |
|---|---|---|
| `api_keys` | `key_hash`(SHA-256, unique)、`key_prefix`、`user_claimed_at`、`models`(允许模型, 空=全部)、`rpm_limit`/`tpm_limit`、`revoked`、`deleted_at` | 审批不向管理员返回明文；申请用户首次访问 Keys 页时领取且仅返回一次 |
| `model_registry` | `id/name/provider/status/category`、`base_url/model_api_name/api_key/import_format/custom_headers`、`resolve_to_model_id`、`extra`(endpoints[]/upstream_path/engine_type/scenes/badge/tags)、`pricing_input/output` | 模型注册表 + 部署配置 |
| `usage_logs` | key/model/tokens/缓存指标/延迟/状态码/错误/成本 | 计量事实表；索引：created_at、(key,created)、(model,created) |
| `users` | `auth_id`(账号 ID, unique)、`password_hash`(PBKDF2, 可空)、`token_version`、`is_active` | 本地账号；改密/重置/注销通过服务端版本与状态即时撤销旧 JWT |
| `applications` | 密钥申请工单（pending/approved/rejected） | 审批流 |
| `forum_posts/replies/likes/follows` | 社区问答 | 问题反馈 |
| `notifications` / `research_articles` | 公告 / Research 文章 | 内容运营 |
| `audit_logs` | actor/action/target/detail | 管理操作审计 |
| `ops_reports` | kind/period/health/metrics(JSON) | 巡检报告，(kind,period_start) 唯一 |

迁移：`001` 基线（create_all）→ `004` 删除档位列 → `005` 增加单 Key 限流列 → `006` 新增 `usage_daily_summary` 永久汇总表并从现存 `usage_logs` 一次性回填。容器 entrypoint 每次启动自动 `alembic upgrade head`。

---

## 11. 管理后台与用户控制台

### 11.1 管理后台（/admin.html）

首次访问时由管理员输入并确认强密码，平台将版本化 PBKDF2 哈希写入
`platform_settings` 表中 `key=admin_credentials` 的记录；生产部署必须注入一次性
高熵 `ADMIN_BOOTSTRAP_TOKEN` 保护首次认领。后续密码验证成功后签发 4 小时 admin
会话，浏览器使用 HttpOnly/SameSite Cookie，Bearer JWT 仍兼容自动化客户端。
源码、镜像和环境变量均不保存管理员明文口令。左侧分组侧边栏布局：

| 分组 | 页面 | 能力 |
|---|---|---|
| 运营监控 | 数据看板 | 今日/本月/累计调用、近5分钟实时、趋势图、模型分布、活跃项目 Top |
| | 运营报告 | 巡检报告列表/详情/手动生成，可导出 PDF |
| | 调用日志 | 全平台调用记录检索与详情 |
| 资源管理 | 密钥管理 | 发放/吊销/恢复/删除；单 Key RPM/TPM 限额；CSV 导出 |
| | 模型管理 | 上下架、部署配置、虚拟模型对齐、定价 |
| | 用户管理 | 账号增删改、密码重置 |
| 系统 | 数据迁移 | 旧平台 CSV 导入、首页累计基线设定 |

### 11.2 用户控制台（/）

模型广场、接口文档（限额实时下发）、API Keys、用量统计（含 RPM/TPM 实时速率面板，按秒刷新）、调用日志、问题反馈（论坛）、Research。所有统计按登录用户聚合；JWT claims 必须先通过用户活动状态与 `token_version` 的服务端校验，禁止凭账号 ID 查询他人数据。

---

## 12. 配置体系

开发环境有明确标记的本地默认值。生产环境必须显式设置 `DATABASE_URL`、`REDIS_URL`、`REDIS_PASSWORD`、至少 32 字符的 `JWT_SECRET`、独立数据加密密钥和至少 32 个随机字节生成的 `ADMIN_BOOTSTRAP_TOKEN`，否则后端拒绝启动。

| 配置 | 示例 / 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://platform:${POSTGRES_PASSWORD}@postgres:5432/openapi_platform` | compose 服务名 |
| `REDIS_URL` | `redis://:${REDIS_PASSWORD}@redis:6379/0` | |
| `JWT_SECRET` | 部署时注入 | 管理员密码不走环境变量，首次访问后台时设置 |
| `JWT_TTL_HOURS` / `USER_JWT_TTL_HOURS` | 4 / 8 | 管理员/用户会话时长，生产限制为 1–24 小时 |
| `ADMIN_BOOTSTRAP_TOKEN` | 生产必填 | 首次管理员认领的一次性高熵令牌；推荐 `openssl rand -hex 32` |
| `ADMIN_SENSITIVE_ACTION_MAX_AGE_S` | 600 | 密钥、导出、原始备份与迁移等高风险动作的重新验证窗口 |
| `ALLOW_PUBLIC_REGISTRATION` / `ALLOW_PASSWORD_RECOVERY` | false / false | 自助注册与 API Key 密码找回显式开关 |
| `AUTH_CACHE_TTL_S` | 3.0 | 热路径鉴权缓存 |
| `RATE_LIMIT_RPM` / `RATE_LIMIT_TPM` | 600 / 6,000,000 | 平台默认，可按 Key 覆盖 |
| `RATE_LIMIT_DEFAULT_MAX_OUTPUT_TOKENS` | 4096 | 请求省略/误填输出上限时的 TPM 预扣预算 |
| `RATE_LIMIT_HIGH_RPM` / `RATE_LIMIT_HIGH_TPM` | 3,000 / 60,000,000 | 「高并发」一键档位预设值 |
| `NIGHT_UNLIMITED_ENABLED` | false | 高风险夜间绕过兼容开关，默认关闭 |
| `RATE_LIMIT_MODEL_EXEMPTIONS_ENABLED` | false | embedding/reranker 限流豁免，默认关闭 |
| `GUNICORN_WORKERS` / `HTTPX_MAX_CONNECTIONS` | 4 / 256 | |
| `UPSTREAM_CONNECT_TIMEOUT_S` / `UPSTREAM_READ_TIMEOUT_S` | 10 / 600 | |
| `USAGE_LOG_RETENTION_DAYS` | 90 | |
| `OPS_REPORT_ENABLED` | false | 运营日报开关 |
| `REDIS_SENTINEL_NODES/MASTER/PASSWORD` | 空（直连） | 高可用可选 |
| `REDIS_CONNECT_TIMEOUT_S` / `REDIS_SOCKET_TIMEOUT_S` / `RATE_LIMIT_ADMISSION_TIMEOUT_S` | 2 / 2 / 3 | Redis 连接、命令与整段准入秒数上限 |

---

## 13. 部署与运维

### 13.1 本地开发

```bash
./dev.sh            # docker 起 postgres+redis + 本机 uvicorn(:8010) + vite(:5173)
./dev.sh --status   # 状态与端口探测
./dev.sh --stop
```

### 13.2 在线部署

```bash
cp .env.example .env
# 填写所有必填随机密钥后：
docker compose --env-file .env config
docker compose --env-file .env up -d --build --wait
```

`docker-compose.yml` 是源码构建入口；`docker-compose.app.yml` 保留给预构建镜像与
离线包。两者共享相同的运行时安全、健康检查、持久卷与日志轮换配置。

### 13.3 离线部署

```bash
# 外网打包机
TARGET_PLATFORM=linux/amd64 bash build-offline.sh
# 可选：VITE_PUBLIC_API_ORIGIN=http://api.example bash build-offline.sh

# 拷贝 offline-images/ 到内网后
cd offline-images
shasum -a 256 -c checksums.sha256   # 可选
bash deploy-offline.sh              # load → tag 补打 → compose up（COMPOSE_PULL_POLICY=never）

# 仅更新 compose/脚本（镜像已在机上）
SKIP_IMAGE_LOAD=1 bash deploy-offline.sh
```

镜像 tar 带 gzip 与 `image-manifest.txt` 架构校验；PostgreSQL 使用 Compose 项目隔离的数据卷（同机多套部署须使用不同 `COMPOSE_PROJECT_NAME`）。
当前签名 GitHub/GHCR 正式发行物以 `linux/amd64` 为目标；`TARGET_PLATFORM=linux/arm64` 是已验证的本地源码/离线构建路径，不表示已发布签名 arm64 正式发行物。
运行期备份为经 `pg_restore --list` 校验的 PostgreSQL custom-format `.dump` 快照；格式压缩不等于加密，部署方仍须使用加密存储、访问控制与离机副本保护。开源发行包不含数据库 seed/dump；可选演示汇总数据由 `demo_seed.py` 在全新空库中生成。
离线包含 `package-info.txt`（构建版本）与 `.env`（禁止 pull）。

### 13.4 Redis 高可用

配置 `REDIS_SENTINEL_NODES=host:port,host:port,...` 后经 Sentinel 发现 master，故障切换自动跟随。标准 Sentinel Compose overlay 会把节点、master、密码与 DB 参数实际注入 backend。恢复时间取决于部署方的 Sentinel 参数，应在目标环境通过故障演练验收；切换窗口内中继准入在总超时后返回可重试的 `503`。

### 13.5 观测点

- `GET /health`：db/redis 连通性 + 用量丢弃计数；
- 响应头：`X-Resolved-Model` / `Retry-After` / `X-Request-Id`；
- 后端日志：Redis/依赖故障、上游非 JSON 告警等结构化 warning。

---

## 14. 安全基线

| 项 | 机制 |
|---|---|
| API Key 存储 | 仅存 SHA-256 哈希 + 前缀；审批密钥明文只在申请用户首次领取时一次性返回 |
| 浏览器会话 | 用户 8h、管理员 4h；HttpOnly/SameSite Cookie，不把 JWT 持久化到 Web Storage；Bearer 保持 API 兼容 |
| 管理面鉴权 | 管理员首次访问设密、PBKDF2-SHA256 600,000 轮哈希；生产强制高熵 bootstrap token；登录失败按来源与账号限流；后台改密需当前密码且会撤销全部旧管理员 JWT；高风险动作要求最近 10 分钟内验证 |
| 用户会话撤销 | `token_version` + `is_active` 每次请求服务端校验；改密、管理员重置、注销立即使旧 JWT 失效 |
| 越权防护 | 密钥列表/统计/日志/论坛身份取自已完成服务端校验的 claims，禁止凭账号 ID 查询他人数据 |
| 网络面 | PG/Redis 仅绑 127.0.0.1，容器间走 compose 内网；Redis requirepass |
| 速率控制 | 单 Key RPM/TPM 限流（数值预设可在后台按 Key 配置）；夜间与模型类别绕过默认关闭；Redis 故障时准入 fail-closed |
| 审计 | 管理操作全量落 `audit_logs` |
| CORS / CSRF | 跨域通配仅覆盖 `/v1/*`、`/beta/v1/*` 的显式 Authorization/x-api-key 客户端且不允许 credentials；`/api/*` 会话与首次认领保持 same-origin + SameSite |

**已知取舍**：管理后台当前仍是单一共享管理员身份，虽然改密会撤销旧会话，但审计无法区分共享密码背后的自然人；JWT 密钥必须由部署方注入并由所有 worker 共享。管理员密码不进入源码、镜像或环境变量。

---

## 15. 测试、标定与验收方法

### 15.1 测试套件

`backend/tests` 包含持续扩展的自动化测试套件，主要覆盖：

| 文件 | 覆盖 |
|---|---|
| `test_policy` | RPM/TPM 预扣/原桶校正/原子返还/单请求超限/单 Key 覆盖/Redis error 与 hanging fail-closed |
| `test_anthropic` | 双向转换：system 置顶合并、tool 顺序、多模态、工具映射 |
| `test_token_estimate` | 全格式 prompt + 输出别名/多候选 TPM 预扣估算 |
| `test_usage_extract` | chat/Responses 双格式 usage 提取 |
| `test_db_bridge_cache` | 鉴权缓存命中/失效/防打穿 |
| `test_routing / test_auth_client / test_platform` 等 | 端点解析、鉴权、REST 面 |

运行：

```bash
cd backend && ./.venv/bin/python -m pytest tests/ -q
```

### 15.2 容量标定

网关不设并发上限（§7），容量标定的对象是**推理引擎自身的准入参数**：vLLM `--max-num-seqs` / SGLang `--max-running-requests` 按显存与目标上下文设定（详见 `docs/scheduling.md`）。验证引擎参数是否合理时用压测：

```bash
python scripts/calibrate.py --base http://127.0.0.1:8021 --model <id> --key sk-platform-xxx \
    --levels 1,2,4,8,16,32,64,128 --secs 6
```

逐档加压找吞吐拐点，即该节点在当前引擎参数下的真实容量。运营层面由日报的容量饱和体检持续巡检：`saturation_suspect`（高峰/低谷时延中位数膨胀比 ≥ `OPS_SATURATION_INFLATION_WARN`，默认 4 倍 → 引擎高峰期饱和，扩节点/收紧引擎准入/引导错峰）。

### 15.3 目标环境验收

发行版不携带生产性能或故障测量数据。部署方应在自己的模型、硬件和网络条件下至少验证：

| 验收项 | 建议方法 | 通过标准 |
|---|---|---|
| Sentinel 切换 | 主动终止当前 master 并持续探测限流链路 | 切换期间返回带 `Retry-After` 的 503，并在部署方定义的恢复目标内恢复 |
| 流式断连计量 | 客户端收到首个分片后断开，随后查询用量日志 | 最终状态和已产生的用量能够落库 |
| 鉴权缓存 | 对同一有效 Key 连续请求并观察数据库查询 | 缓存有效期内不重复读取 Key 注册信息 |
| 节点容量 | 使用 `calibrate.py` 逐档加压 | 依据目标 TTFT、吞吐和错误率选择引擎准入参数 |

---

## 16. 相关工作的定位

与现有 LLM 网关/代理相比，平台的差异点在于：

- **可验证的安全准入**：Redis 无法确认跨副本计数时明确返回可重试 503，不把协调故障静默转换成无限流量；
- **完整预算准入**：TPM 预扣覆盖 prompt、最大输出、参数别名和多候选；单请求超过限额时空桶也拒绝，避免事后校正前的成本突发；
- **取消安全执行器**：针对 asyncio level-cancellation 导致 finally 清理丢失的问题，提出 `guarded()` 模式，可作为同类型流式网关的通用修复；
- **安全配置边界**：离线构建自动生成独立随机凭据，在线部署从 `.env.example` 创建本地配置。

---

## 17. 结论与未来工作

平台通过“三层限流 + 直连转发（调度权归引擎）+ 多节点轮询 + 取消安全计量”构建了一座面向内网/离线环境的大模型 API 网关。所有机制均可在论文中作为生产系统实例进行形式化建模与实验验证。

未来可深化的方向：

1. **被动节点熔断**：连接失败后短暂冷却故障节点，单节点故障自动降级为容量损失而非错误率；
2. **全局最优路由**：当前节点选择为轮询，可引入多目标优化（延迟、各节点负载）；
3. **形式化验证**：对 `guarded()` 进行模型检测或规约，证明计量无丢失性质。

---

## 18. 附录

### A. 网关响应头

| 响应头 | 含义 |
|---|---|
| `X-Resolved-Model` | 虚拟模型实际命中的模型 id |
| `Retry-After` | 429（限流）时建议重试等待秒数 |
| `X-Request-Id` | 每次请求唯一追踪 ID，所有响应（含 4xx/429）均携带，用于日志关联与问题排查 |

### B. 错误码速查

| 状态码 | 含义 | 客户端处理 |
|---|---|---|
| 400 | 请求体格式错误 / 上游模型拒绝（如输入超过部署上下文，网关透传上游错误，§4.5） | 按错误信息修正请求（超限时缩短输入或改用更大上下文的模型），不建议原样重试 |
| 401 | Key 无效或已吊销 | 检查密钥 |
| 403 | Key 已禁用 / 无权调用该模型 | 联系管理员 |
| 404 | 模型不存在或已下线 | 检查模型 id |
| 408 | 上游响应超时（生成时间过长或临时拥塞） | 稍后重试；流式请求同时检查网络 |
| 413 | 请求体过大 | 减少单条消息长度、图片数量或工具定义体积，分批发送 |
| 422 | 参数非法 | 按错误信息修正请求参数 |
| 429 | RPM/TPM 超限 | 按 `Retry-After` 退避 |
| 500 | 服务器内部错误 | 稍后重试；持续出现联系管理员 |
| 503 | 模型未完成部署 / 上游过载或不可达（透传） | 稍后重试；持续出现联系管理员 |

### C. 关键 Redis 键一览

| 键 | 类型 | 用途 |
|---|---|---|
| `rl:rpm:{key}:{bucket}` | string | RPM 分钟窗口 |
| `rl:tpm:{key}:{bucket}` | string | TPM 分钟窗口（预扣+校正+返还） |
| `apply:rate:{ip}:{bucket}` | string | 密钥申请小时窗口 |

### D. 核心配置默认值汇总

| 配置项 | 默认值 | 配置项 | 默认值 |
|---|---|---|---|
| `GUNICORN_WORKERS` | 4 | `HTTPX_MAX_CONNECTIONS` | 10,000 |
| `RATE_LIMIT_RPM` | 600 | `RATE_LIMIT_TPM` | 6,000,000 |
| `AUTH_CACHE_TTL_S` | 3.0 | `USAGE_LOG_RETENTION_DAYS` | 90 |
| `OPS_REPORT_ENABLED` | false | | |

### E. 管理/用户 REST 端点速查

#### 公开端点（无需认证）

- `GET /api/public/config` — 公开平台配置，含实时默认限额 `rate_limit:{rpm,tpm}`
- `GET /api/public/platform-status` — 平台运营状态
- `GET /api/public/models` / `GET /api/public/models/{model_id}` — 模型元数据
- `GET /api/public/notifications` — 平台公告
- `GET /api/public/research` / `GET /api/public/research/{article_id}` — Research 文章
- `POST /api/apply` — 自助申请 API Key

#### 用户端点（JWT）

- 认证：`POST /api/user/login`、`POST /api/user/logout`、`GET /api/user/session`；浏览器使用 HttpOnly/SameSite Cookie，Bearer JWT 保持 API 兼容
- 用量统计：`GET /api/user/stats`、`/api/user/stats/yearly`、`/api/user/stats/daily`、`/api/user/stats/models`、`/api/user/stats/projects`、`/api/user/stats/timeseries`、`/api/user/stats/context-length`、`/api/user/stats/heatmap`
- 日志与速率：`GET /api/user/logs`、`GET /api/user/logs/stats`、`GET /api/user/rate-limits`、`POST /api/user/usage`、`POST /api/user/logs`
- 密钥管理：`POST /api/user/keys`、`POST /api/user/keys/{key_id}/claim`（审批后申请人首次领取）、`PATCH /api/user/keys/{key_id}`、`DELETE /api/user/keys/{key_id}`
- 论坛：`GET /api/forum/overview`、`GET /api/forum/posts`、`POST /api/forum/posts`、`GET /api/forum/posts/{post_id}`、`POST /api/forum/posts/{post_id}/replies`、`POST /api/forum/posts/{post_id}/like`、`POST /api/forum/posts/{post_id}/follow`、`POST /api/forum/posts/{post_id}/resolve`

#### 夜间批量端点（JWT）

- `GET /api/night-batch`、`POST /api/night-batch`、`DELETE /api/night-batch/{reg_id}`、`DELETE /api/night-batch/series/{series_id}`

#### 管理端点（admin JWT）

- 登录：`GET /api/admin/login/status`、`POST /api/admin/login`、`GET /api/admin/session`、`POST /api/admin/logout`
- 模型：`GET`/`PUT`/`PATCH`/`DELETE /api/admin/models`、`POST /api/admin/models/sync`、`POST /api/admin/models/{model_id}/launch`
- 密钥：`GET`/`POST /api/admin/keys`、`POST /api/admin/keys/{key_id}/limits` / `revoke` / `restore`、`DELETE /api/admin/keys/{key_id}`
- 申请：`GET /api/admin/applications`、`POST /api/admin/applications/{app_id}/approve` / `reject`
- 用户：`GET`/`POST /api/admin/users`、`PUT /api/admin/users/{user_id}`、`POST /api/admin/users/{user_id}/reset-password`、`DELETE /api/admin/users/{user_id}`
- 统计：`GET /api/admin/stats/*`（`daily`/`monthly`/`by_model`/`by_project`/`by_user`/`overview`）、`GET /api/admin/usage`、`GET /api/admin/usage/stats`
- 报告：`GET /api/admin/reports`、`GET /api/admin/reports/{report_id}`、`POST /api/admin/reports/generate`
- 审计：`GET /api/admin/audit-logs`
- 迁移/备份：`GET /api/admin/backup/export`、`GET /api/admin/migration/baseline`、`PUT /api/admin/migration/baseline`、`POST /api/admin/migration/import`、`POST /api/admin/migration/import/users`、`POST /api/admin/migration/import/keys`
- 内容运营：`GET`/`POST /api/admin/notifications`、`DELETE /api/admin/notifications/{notification_id}`、`GET`/`POST /api/admin/research`、`DELETE /api/admin/research/{article_id}`

---

*本文档对应当前代码基线；具体版本请以发行标签为准。*

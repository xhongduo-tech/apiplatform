# Open API Platform

一个可自主部署、面向多模型供应商的大模型 API 网关与运营平台。平台提供 OpenAI / Anthropic 兼容接口，并将模型接入、密钥发放、流量治理、用量分析、基础设施状态和运营管理整合到同一套控制台中。

本开源快照不包含原内部系统的真实用户、API Key、请求日志、上游凭据、组织信息或基础设施拓扑。新实例可选择载入完全虚构的演示汇总数据；其中的演示 Key 均不可调用。

## 核心能力

- OpenAI Chat Completions、Completions、Responses 与 Anthropic Messages 兼容接口。
- FastAPI 异步流式中继，支持 SSE、模型路由、故障转移、熔断和多节点轮询。
- PostgreSQL 持久化与 Redis 跨实例 RPM / TPM 限流。
- 模型、API Key、用户、申请、场景、报表、审计日志和运行状态管理。
- 用户控制台、管理后台、公开文档与匿名状态看板。
- 平台名、品牌名、组织、页脚、支持/审批部门和联系信息均由管理员配置。
- 本地账户使用强密码、登录限流与 HttpOnly 会话 Cookie；API 客户端仍可使用 Bearer JWT。
- 敏感配置使用 AES-256-GCM 加密，API Key 明文只在领取或重新生成时返回一次。
- Docker Compose、自动校验备份、Prometheus / Grafana 监控与全离线部署包。

## 架构概览

```text
Browser / SDK
      │
      ▼
    Nginx ─────────────── React 控制台与管理后台
      │
      ▼
 FastAPI Gateway ─────── Redis（限流、缓存、跨节点状态）
      │  │
      │  └────────────── PostgreSQL（配置、账户、用量、审计）
      │
      └───────────────── OpenAI / Anthropic 兼容上游
```

详细设计见 [技术说明](docs/TECHNICAL.md)。

## 快速开始

开发环境需要 Docker、Python 3.11+ 和 Node.js 20+：

```bash
./dev.sh
./dev.sh --status
./dev.sh --stop
```

开发脚本只使用明确标记为 development 的本地凭据。生产配置会拒绝空值、弱值和仓库示例值。

## 生产部署

### 1. 准备配置

复制环境变量模板：

```bash
cp .env.example .env
```

编辑 `.env`，至少为以下项目生成彼此独立的随机值：

```bash
# POSTGRES_PASSWORD、REDIS_PASSWORD、JWT_SECRET、ADMIN_BOOTSTRAP_TOKEN 分别生成一次
openssl rand -hex 32

# DATA_ENCRYPTION_KEY 必须是独立的 32 字节 URL-safe base64
openssl rand -base64 32 | tr '/+' '_-' | tr -d '=\n'
```

不要提交 `.env`，也不要复用数据库密码、JWT 密钥与数据加密密钥。接入 HTTPS 后，将 `SESSION_COOKIE_SECURE` 改为 `true`。

### 2. 构建并启动

```bash
docker build -t apiplatform-backend:latest ./backend
docker build -f nginx/Dockerfile \
  --build-arg VITE_PUBLIC_API_ORIGIN=http://localhost \
  -t apiplatform-nginx:latest .
docker compose --env-file .env -f docker-compose.app.yml up -d
```

默认入口：

- 用户站点：`http://127.0.0.1/`
- 管理后台：`http://127.0.0.1/admin.html`
- 健康检查：`http://127.0.0.1/health`
- Prometheus：`http://127.0.0.1:9090`
- Grafana：`http://127.0.0.1:3000`

数据库、Redis、监控和 Web 入口默认只绑定宿主机回环地址。完成初始化后，再通过受控反向代理、指定管理网地址或显式修改 `HTTP_BIND_ADDRESS` 对外提供服务。

### 3. 首次管理员认领

发行版不携带固定 admin 密码。首次打开 `/admin.html` 时，由管理员设置并确认强密码；数据库只保存版本化 PBKDF2-SHA256 哈希。

建议在 `.env` 配置一次性 `ADMIN_BOOTSTRAP_TOKEN`。首次认领必须同时提供此令牌，认领成功后它不再参与登录。该流程使用数据库锁保证并发安全，新实例应在本机或受信网络完成认领后再开放入口。

### 4. 平台配置

登录管理后台后，可在「品牌配置」中设置：

- 平台名称、简称与品牌名称；
- 运营组织、支持部门与审批部门；
- 联系邮箱、页脚与展示文案；
- 中英文界面的对应显示内容。

这些值保存在数据库中，不需要修改或重新构建前端代码。

## API 调用示例

OpenAI 兼容请求：

```bash
curl http://127.0.0.1/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "your-model-id",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

Anthropic 兼容请求：

```bash
curl http://127.0.0.1/v1/messages \
  -H 'x-api-key: YOUR_API_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "your-model-id",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

模型标识与 Key 由管理员在后台创建和发放；演示 Key 不具备调用权限。

## 演示数据

`DEMO_DATA_ENABLED=true` 时，后端只会在 `users` 与 `api_keys` 均为空的新数据库中写入虚构用户、已撤销 Key 和 30 天汇总趋势。它不会写入请求正文、响应预览、错误详情、真实组织名称或可用凭据，也不会混入已有实例。

需要完全空白的新库时，将其设置为：

```dotenv
DEMO_DATA_ENABLED=false
```

## 安全边界

- 公开注册与基于 API Key 的密码找回默认关闭。
- 用户密码和管理员密码统一执行 12–128 位强密码策略。
- 浏览器登录使用 HttpOnly、SameSite Cookie；改密、重置或删除账户后，旧会话立即失效。
- 上游密钥等敏感配置使用独立的 `DATA_ENCRYPTION_KEY` 加密保存。
- 用量内容默认不落库，只记录状态、Token、延迟与不含正文的错误分类。
- 原始数据库备份默认不能从管理后台下载，需要部署方显式开启。
- Nginx 只信任明确配置的代理网段，并拒绝全网可信代理配置。
- 生产数据库和 Redis 默认仅绑定回环地址。
- 仓库不应包含数据库导出、运行日志、私有演示稿或历史产物。

安全问题请按 [安全政策](SECURITY.md) 私下报告，不要在公开 Issue 中披露漏洞细节。

## 备份、恢复与离线部署

Compose 中的备份边车默认每小时生成并校验一份 PostgreSQL custom-format 快照，保留最近 168 份。导出与恢复命令：

```bash
bash scripts/export-backup.sh
bash scripts/restore-backup.sh /absolute/path/to/backup.dump
```

恢复会改写数据库，请先阅读脚本提示并在隔离环境验证备份。

构建全离线部署包：

```bash
TARGET_PLATFORM=linux/amd64 bash build-offline.sh
cd offline-images
bash deploy-offline.sh
```

离线包会独立生成部署凭据，并拒绝收录 `.dump` / `.sql` 数据库文件。详见 [离线部署说明](OFFLINE.md)。

## 开发与验证

后端：

```bash
python -m pip install -r backend/requirements-dev.txt
ruff check backend
pytest -q backend/tests
```

前端：

```bash
cd frontend
npm ci
npm run check:i18n
npm run typecheck
npm test
npm run build
```

公开发布前：

```bash
bash scripts/check-public-release.sh
```

该检查会扫描当前文件和 Git 历史中的凭据、数据库导出、旧品牌标识及内部资料路径。完整发布步骤见 [发布清单](docs/RELEASE_CHECKLIST.md)。

## 项目结构

```text
backend/    FastAPI 网关、管理 API、迁移与测试
frontend/   React 控制台、后台、文档与样式
nginx/      反向代理、静态站点与安全响应头
postgres/   PostgreSQL 配置、备份与健康检查
monitoring/ Prometheus 规则与 Grafana 看板
scripts/    部署、迁移、备份和发布验证工具
docs/       技术、调度、故障转移和发布文档
```

## 参与贡献

请先阅读 [贡献指南](CONTRIBUTING.md) 与 [行为准则](CODE_OF_CONDUCT.md)。提交代码前应完成相关测试，并确保 `scripts/check-public-release.sh` 通过。

## 许可证

本项目的开源许可见 [LICENSE](LICENSE)。

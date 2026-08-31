# 离线部署指南

平台可在无公网环境运行。外网打包机构建并导出 6 个镜像，目标机仅需 Docker 与 Compose。
Compose 会按项目名隔离容器和数据卷；同一宿主机部署多套时，必须为每套设置唯一的
`COMPOSE_PROJECT_NAME`（例如 `apiplatform_team_a`），并在各自 `.env` 中为
`HTTP_PORT`、`POSTGRES_PORT`、`REDIS_PORT`、`PROMETHEUS_PORT` 和
`GRAFANA_PORT` 分配不冲突的宿主机端口。PostgreSQL、Redis、Prometheus 默认只
绑定回环地址；不需要从宿主机访问时，部署方也可在独立生产 override 中移除这些端口映射。

## 1. 安全边界

- 离线包不包含任何运行数据库、用户、API Key、请求日志、上游凭据或内部拓扑。
- `build-offline.sh` 只复制显式白名单中的 Git tracked 普通文件；
  `scripts/offline-package-verify.sh` 在构建和部署时拒绝任意目录中的数据库导出、
  私钥、嵌套 `.env`、日志/生成物和符号链接。
- 发行包只含无秘密的 `.env.template`；`deploy-offline.sh` 首次在目标机以 0600
  权限原子生成独立的数据库、Redis、JWT、bootstrap 和数据加密密钥，已有 `.env`
  永不覆盖。不要把一台机器生成的 `.env` 复制给另一套部署。
- 自助注册与 API Key 密码找回默认关闭；Grafana 默认不创建共享管理员。
- 四个第三方运行时镜像直接读取并复用 `docker-compose.app.yml` 的完整
  `sha256` RepoDigest；后端与 nginx 的 Dockerfile 基础镜像也必须带完整
  digest；可选 Python wheel 兜底也从 `requirements.lock` 以 `--require-hashes`
  下载。打包脚本拒绝 `latest`、可变 `FROM`、短 Git SHA 和脏工作树。

### 真实性与官方发布边界

`build-offline.sh` 生成的是可审计的**用户本地构建包**，不是官方签名发行物。
`package-info.txt`、`package-manifest.txt` 和 `image-manifest.txt` 都固定同一个
40 位 Git commit，并用 SHA-256 绑定目标平台与 `VITE_PUBLIC_API_ORIGIN`。全部六个
本地 tag 均直接由构建后的完整 image ID 寻址，所以异构架、异配置或网络依赖导致的
不同构建内容都不会静默覆盖同名 tag。每个镜像同时记录本地内容寻址
image ID，第三方镜像再绑定 Compose 中的
上游 RepoDigest。内部状态固定为 `UNSIGNED_USER_BUILD`，不能通过
改字段把 SHA-256 冒充发布者身份。

官方 GHCR 的两个项目镜像由发布工作流按 RepoDigest 生成并验证 GitHub/Sigstore
build provenance，再单独进行 Cosign 签名与 SPDX SBOM attestation。当前正式发布
流程**尚未签署完整离线目录的外层 manifest**，因此维护者不得把手工生成的
`offline-images/` 作为“官方离线包”上传或销售。正式离线发行的阻断条件是：发布
工作流消费刚发布的两个 GHCR RepoDigest、固定四个上游 RepoDigest，并签署一个
绑定压缩包 digest、完整 commit 与六个镜像来源 digest 的外层 manifest。

## 2. 外网打包

```bash
# 必须从目标 commit 的干净工作树执行
git status --short

# 默认为 linux/amd64
bash build-offline.sh

# Apple Silicon 为 x86_64 服务器构建
TARGET_PLATFORM=linux/amd64 bash build-offline.sh

# 将前端使用的公开基址烘焙进 nginx 镜像
VITE_PUBLIC_API_ORIGIN=https://api.example.com bash build-offline.sh
```

产物在 `offline-images/`，包含 `apiplatform-*.tar.gz`、`docker-compose.yml`、无秘密的
`.env.template`、部署/运维脚本、监控配置和校验和。目标机首次运行部署脚本才生成
`.env`。`package-info.txt` 中 `seed_included=synthetic` 表示演示数据由后端代码生成，
不是数据库镜像或 dump。镜像 tag 使用完整本地 image ID，清单另外绑定完整 commit、
上游来源 digest 和构建变体指纹，不使用 `latest`。脚本对任意未跟踪文件（包括
`release/`）均失败，且
`.dockerignore` 会阻止本地发行物进入 BuildKit 上下文。`checksums.sha256` 只能发现
拷贝损坏或内容变化，不能证明发布者身份。

## 3. 内网部署

将整个 `offline-images/` 目录复制到目标机：

```bash
cd offline-images
bash scripts/offline-package-verify.sh deploy
bash deploy-offline.sh
```

部署脚本会在 source 其它运维脚本前再次校验全量文件覆盖、checksum、完整 commit、
六个镜像来源与架构；加载后还会逐个核对完整 image ID，拒绝本机同名 tag 指向其它
内容。随后先启动 PostgreSQL，再启动应用、Redis、nginx 和监控，最后等待
nginx 容器内部的 `/health` 返回 `status=ok`。该探测不依赖宿主机的
`HTTP_BIND_ADDRESS` / `HTTP_PORT`，因此自定义绑定地址或端口不会被误报为启动失败。

默认入口为 `http://127.0.0.1:80`，且仅绑定回环地址。对外域名、TLS 和 DNS 由部署方配置。可在 `.env` 中修改 `HTTP_BIND_ADDRESS`、`HTTP_PORT`、`GRAFANA_BIND_ADDRESS` 和 `GRAFANA_PORT`。

若 nginx 前还有 TLS 终结器或负载均衡器，应把该代理的**精确地址或私网 CIDR**写入
`TRUSTED_PROXY_CIDRS`（多个值逗号分隔），认证限流才会按真实客户端 IP 计算。
平台默认不信任客户端提供的 `X-Forwarded-For`，并拒绝 `0.0.0.0/0`、`::/0`；
不要为图方便放宽到任意来源。

## 4. 首次初始化

### 管理员密码

首次打开 `/admin.html` 时输入目标机 `.env` 中的 `ADMIN_BOOTSTRAP_TOKEN`，并设置、确认 12–128 位强密码。平台仅保存 PBKDF2-SHA256 哈希；认领成功后 bootstrap token 不再参与登录。

> 这是 first-claim 规则：第一个成功初始化的访问者成为管理员。应先限制在本机或受信网络，设密完成后再开放外部访问。

远程服务器可先用 `ssh -L 8080:127.0.0.1:80 <server>` 建立隧道，再访问 `http://127.0.0.1:8080/admin.html`。初始化后如需将 `.env` 中的 `HTTP_BIND_ADDRESS` 改为 `0.0.0.0`、指定管理网地址或通过域名提供服务，必须先接入可信 TLS 反向代理并设置 `SESSION_COOKIE_SECURE=true`，然后重启 backend 与 nginx；不得把默认 `false` 的会话 Cookie 暴露在外部明文 HTTP 上。

### 演示数据

默认 `DEMO_DATA_ENABLED=true`。只有 `users` 和 `api_keys` 同时为空时才会生成：

- 3 个虚构用户，不设置密码；
- 3 个已撤销且无明文/无哈希的演示 Key；
- 30 天虚构的日/小时汇总数据；
- 一条标明数据为虚构的通知。

不生成原始调用日志、请求或响应内容。如果希望从纯净空库开始，在首启前将该值改为 `false`。

### 品牌与组织信息

管理员登录后，在「品牌配置」中设置品牌名、平台名、浏览器标题、组织名、标语、页脚和支持/审批联系信息。公开页和管理页都从运行时配置读取，无需重新构建前端。

## 5. 运行维护

```bash
bash scripts/compose.sh ps
bash scripts/compose.sh logs -f backend
SKIP_IMAGE_LOAD=1 bash deploy-offline.sh
bash scripts/export-backup.sh /data/backups
bash scripts/restore-backup.sh /data/backups/openapi_platform_YYYYmmdd_HHMMSS.dump
```

`pg-backup` 默认每小时生成、校验一份 PostgreSQL custom-format 快照，保留最近
168 份并维护 `/backups/latest.dump` 链接。快照只经过压缩和完整性校验，**并未
整体加密**；它包含当前运行数据，必须由部署方通过加密存储、访问控制和离机副本
保护，且不得放入源码仓库或公开发行包。

## 6. 发布前验证

```bash
bash scripts/check-public-release.sh
OFFLINE_DIR=offline-images bash scripts/offline-package-verify.sh build
```

请从清理后的当前文件创建新的公开 Git 仓库，不要推送原私有仓库的 `.git` 历史。

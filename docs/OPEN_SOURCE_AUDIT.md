# 开源发布复审与改进建议

审计日期：2026-08-25

## 结论

当前源码已经完成首个公开稳定版本前的全部 P1 整改：真实数据和旧组织标识已清理，
本地 Git 历史已净化，CI 供应链固定、真实浏览器 E2E、四个 F 级热点拆分、统一版本
发布、生产 OpenAPI 策略、社区协作入口和标准 Docker Compose 源码部署均已落地。
PostgreSQL、Redis、Prometheus 与 Grafana 默认镜像已固定到经过实机验证的 digest，
本轮未发现需要阻止发布的 P0 级应用漏洞。

下一阶段不建议继续做大范围无目标重写。剩余工作属于发布后的持续演进，优先级应
集中在前端可访问性/覆盖率门禁、大组件拆分、性能基线和自动恢复演练。

## 本轮验证基线

| 检查 | 结果 |
| --- | --- |
| 空 PostgreSQL 迁移 | 从基线迁移到 revision 035 成功 |
| 后端测试 | 491 项通过；覆盖率 67.45%（门禁 60%） |
| 前端测试 | 24 项通过 |
| 全栈浏览器 E2E | 2 条发布关键链路通过（真实 Nginx/FastAPI/PostgreSQL/Redis） |
| 多语言字典 | en / zh-CN / zh-TW，各 2,633 键一致 |
| 前端生产构建 | TypeScript 与 Vite 构建通过 |
| Python 静态检查 | Ruff 通过；Bandit 高严重度检查无发现 |
| 依赖漏洞 | pip-audit 与 npm audit 无已知漏洞 |
| 发布卫生 | 版本、tag 规则、静态 OpenAPI 与 `scripts/check-public-release.sh` 全部通过 |
| Compose | 标准源码入口、预构建入口与 Redis Sentinel overlay 校验通过；七服务空卷启动全部 healthy |
| 容器镜像 | 后端与 Nginx 的 Trivy HIGH/CRITICAL 均为 0；Redis 为 0 |
| 备份链路 | 空卷启动自动生成 custom-format 快照，SHA-256 校验通过 |
| 重复代码 | 0.73%，不构成系统性问题 |
| Python 复杂度 | 四个原 F 级发布热点已降至 A(2)、A(5)、B(10)、A(2) |

## P0：发布阻断项

本轮未发现 P0 阻断项。

仍应在每次公开发布前重复执行发布卫生检查、依赖审计、容器扫描与备份恢复演练；
一次通过不等同于长期安全保证。

## P1：首个公开稳定版本前任务（已完成）

### 1. 固定 GitHub Actions 与 CI 服务镜像

完成状态：所有 Action 固定到完整 commit SHA，CI PostgreSQL 固定 digest，所有
checkout 禁止持久化凭据，并加入并发取消与 Dependabot。zizmor 复查无发现。

已实现：

- 将所有第三方 Action 固定到完整 commit SHA，并在行尾注释对应版本。
- 为所有 `actions/checkout` 设置 `persist-credentials: false`。
- 将 CI PostgreSQL 镜像固定到 digest。
- 加入 workflow `concurrency`，取消同分支的过期任务。
- 使用 Dependabot 或 Renovate 自动提出 Action、容器与依赖升级 PR。

验收结果：zizmor 不再报告 unpinned-uses、unpinned-images 或 artipacked。

### 2. 建立浏览器端到端测试

完成状态：新增 Playwright 与隔离 Compose 测试栈，真实构建并运行 Nginx、FastAPI、
PostgreSQL、Redis 与模拟上游。当前自动覆盖：

1. 全新实例首次管理员认领、管理员 Cookie 会话与退出。
2. 品牌配置与恶意 HTML 输入的纯文本安全呈现。
3. 创建模型、发放/领取/调用/撤销 Key。
4. OpenAI 兼容流式响应经 Nginx 到模拟上游的完整链路。
5. 生产环境动态文档端点不公开。

验收结果：CI 使用真实全栈完成 2 条发布关键 E2E，失败时保留脱敏 screenshot、
trace 与 Compose 日志。取消/超时/故障转移及可访问性场景继续列入 P2 扩展范围。

### 3. 拆分高复杂度后端热点

四个 F 级发布热点已拆分为路由编排与独立 helper：

- `admin.patch_model`：F(78) → A(2)
- `admin_stats.list_usage`：F(52) → A(5)
- `user.user_logs_paged`：F(49) → B(10)
- `public._build_platform_status`：F(43) → A(2)
- `responses.responses_to_openai`：E(40)
- `chat._pump`：E(35)
- `heatmap_stats._build_day_band_heatmap`：E(34)
- `migration_import.import_api_keys_csv`：E(32)

后续 E 级热点保留为 P2 增量重构对象；本轮未同时改写流式代理状态机，以控制
行为回归风险。

### 4. 统一版本与发布策略

完成状态：首个公开版本明确为 `1.0.0`，根目录 `VERSION` 是单一版本源，自动校验
前端 package、lockfile、FastAPI 与 CHANGELOG。tag workflow 只接受与版本完全一致
的 `v<SemVer>` 标签。

已实现：

- 首个公开版本为 `1.0.0` 稳定版。
- 以单一版本源校验 FastAPI、package.json、镜像标签和发布说明。
- 定义 SemVer 兼容边界，特别是 `/v1` 代理契约与管理 API。
- 自动生成校验和、SBOM、签名镜像和可验证发布产物。

验收结果：代码、tag 规则、CHANGELOG、GHCR 镜像、SBOM、签名与源码校验和使用
同一版本；实际远程 tag 在合并本次改动后由维护者创建。

### 5. 明确 OpenAPI 文档暴露策略

完成状态：生产环境默认显式关闭 `/docs`、`/redoc` 和 `/openapi.json`，开发环境
可通过 `API_DOCS_ENABLED` 开启。发行包包含只导出 `/v1` 与 `/beta/v1` 的静态
`docs/openapi-gateway.json`。

- 生产环境显式关闭交互式文档，同时在发行产物中提供版本化、脱敏后的静态
  OpenAPI 规范；或
- 将文档放在管理员认证后，通过明确 Nginx location 代理。

验收结果：生产/开发策略有后端自动测试和浏览器 E2E；CI 校验静态规范未漂移且
不包含内部管理路由。

### 6. 补齐开源协作入口

完成状态：已补齐 Bug/功能/支持 Issue 表单、PR 模板、CODEOWNERS、
MAINTAINERS.md、SUPPORT.md、Dependabot，以及 GitHub Private Vulnerability
Reporting 的明确安全报告路径与响应时限。

- Bug、功能建议、文档问题的结构化 Issue 表单。
- PR 模板，要求说明测试、迁移、安全和回滚影响。
- CODEOWNERS 或 MAINTAINERS.md。
- SUPPORT.md，区分安全报告、使用问题和商业支持。
- 明确的私密安全联系人；仅写“仓库元数据中的地址”对新仓库不够具体。

## P2：建议在公开发布后的两个迭代内完成

### 7. 增加前端 lint、覆盖率与可访问性门禁

前端没有 ESLint 脚本，也没有覆盖率阈值。建议启用 TypeScript/React Hooks lint、
Vitest coverage、axe-core 与关键页面的 WCAG 自动检查。先设置不会造成大量历史
噪声的基线，再逐步提高阈值。

### 8. 拆分超大前端组件

`ApplyKeys.tsx` 超过 2,000 行，`admin-models-tab.tsx`、`NightBatch.tsx`、
`admin-keys-tab.tsx` 和 `LogsPanel.tsx` 均超过 1,200 行。建议按数据 hook、
表单 schema、展示组件和对话框边界拆分，并为状态转换编写纯函数测试。

### 9. 模块化多语言资源

三份语言字典合计约 8,700 行。建议按 auth、admin、models、usage、docs 等命名空间
拆分，以 zh-CN schema 自动校验另外两种语言，并在 CI 检查未使用与缺失键。

### 10. 为配置建立机器可读 schema

环境变量分散在配置类、脚本和 Compose 文件中，.env.example 只适合人工阅读。
建议生成带类型、默认值、是否敏感、是否可热更新和生产要求的配置 schema，再由
schema 生成 .env.example 和文档表格，避免文档漂移。

### 11. 扩展运行时供应链证明

当前 Dockerfile 基础镜像以及 Compose 中 PostgreSQL、Redis、Prometheus、Grafana
默认镜像均已固定 digest；发布 workflow 会为项目自建的后端与 Nginx 镜像生成
SPDX SBOM、签名和 provenance。后续应把上游运行时镜像纳入定期 SBOM/漏洞差异
报告，并在上游发布修复镜像后由 Dependabot 或维护者更新 digest。上游镜像中仅在
启动或监控组件使用的 Go 二进制仍可能被扫描器报告新披露问题；部署继续保持回环
监听、最小权限，并以官方重建版本为升级边界。

### 12. 建立性能回归测试

建议提供不含真实数据的 k6 或 Locust 场景，覆盖：

- SSE 长连接、客户端取消与慢消费者。
- RPM/TPM 突发、Redis 故障与 Sentinel 切换。
- PostgreSQL 短时不可用及 usage failover 回灌。
- 模型故障转移、熔断开启与关闭。

将 P95 首字延迟、完成延迟、错误率、连接数和数据丢失数设为版本回归指标。

### 13. 定义 SLO 与运维手册

已有 Prometheus、Grafana 和告警规则，但还应补充请求可用性、网关额外延迟、
用量写入延迟、备份新鲜度和恢复点目标。每条高优先级告警应链接到脱敏 runbook。

### 14. 自动化备份恢复演练

当前备份生成和校验较完整，下一步应在隔离数据库中定期执行真实恢复、迁移到 head、
关键表计数校验和加密密钥匹配检查，并将结果作为发布条件。

### 15. 继续拆分样式与重型前端资源

现代构建的主样式约 249 KB（gzip 约 82 KB），主要重型 JS 分块约 375–415 KB。
当前已按路由拆分主要功能，不属于发布阻断项。后续可把 docs、admin 和用户控制台
样式进一步按入口加载，并对 PDF、图表、论坛模块设置 bundle budget。

## P3：中长期演进

- 导出版本化 OpenAPI 规范并生成官方 Python/TypeScript SDK。
- 提供 Kubernetes Helm Chart，并区分单机 Sentinel 与真正跨主机高可用边界。
- 为关键架构决策建立 ADR，记录认证、密钥交付、数据保留和故障降级取舍。
- 建立独立文档站、升级指南和版本化运维手册。
- 在真实需求出现后再评估 OIDC/企业 SSO 插件；不要把已删除的内部统一认证代码
  重新带回核心登录链路。

## 后续推荐执行顺序

1. 增加前端 lint、覆盖率、axe 可访问性和 bundle budget 门禁。
2. 拆分前端大组件和多语言资源，并继续处理 E 级后端热点。
3. 建立性能基线、SLO/runbook 和自动备份恢复演练。
4. 最后推进 SDK、Helm、文档站和跨主机高可用。

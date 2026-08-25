"""集中式运行时配置。

开发环境提供仅用于本机的中性默认连接串；生产环境由 compose/.env 显式注入随机
凭据。源码中不保存任何可用于部署的共享口令、JWT 密钥或内部认证地址。
"""
from __future__ import annotations

import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _b(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


class Settings:
    # ── 环境 ──────────────────────────────────────────────────────────────
    # production（默认，容器部署）；dev.sh 本地开发注入 development。
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "production").strip().lower()
    # 生产默认不暴露交互式 API 文档；发布包提供经过审查的静态网关规范。
    API_DOCS_ENABLED: bool = _b("API_DOCS_ENABLED", ENVIRONMENT != "production")

    # ── 可选应用扩展 ────────────────────────────────────────────────────────
    # 仅加载部署方显式列出的 Python 模块；顺序即安装/启动顺序。空值保持纯社区版
    # 行为。任何已配置扩展的导入、契约、安装或启动失败都会阻止应用就绪。
    APPLICATION_EXTENSIONS: str = os.getenv("APPLICATION_EXTENSIONS", "").strip()

    # ── 基础 ────────────────────────────────────────────────────────────
    # 下面两个默认值仅支持 development；production 启动时会由 main.py 校验
    # 对应环境变量已显式设置，compose 也使用 :? 语法在启动前阻断缺失配置。
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL", "postgresql+psycopg://platform:platform_dev_postgres@postgres:5432/openapi_platform"
    )
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://:platform_dev_redis@redis:6379/0")

    # ── 备份（pg-backup 边车）────────────────────────────────────────────────
    # pg-backup 边车发布已验证快照的位置，backend 容器只读挂载。
    BACKUP_DIR: str = os.getenv("BACKUP_DIR", "/backups")
    BACKUP_DUMP_FILE: str = os.getenv("BACKUP_DUMP_FILE", "latest.dump")
    BACKUP_INTERVAL_S: int = _i("BACKUP_INTERVAL_S", 3600)

    # ── Redis Sentinel（高可用，可选）───────────────────────────────────────
    # 配置 REDIS_SENTINEL_NODES（逗号分隔 host:port）后经 Sentinel 发现 master，
    # 故障切换自动跟随；留空则直连 REDIS_URL。
    REDIS_SENTINEL_NODES: str = os.getenv("REDIS_SENTINEL_NODES", "").strip()
    REDIS_SENTINEL_MASTER: str = os.getenv("REDIS_SENTINEL_MASTER", "apiplatform-master")
    REDIS_SENTINEL_PASSWORD: str = os.getenv("REDIS_SENTINEL_PASSWORD", "")
    # Sentinel 模式下连 master 用的口令，须与部署配置的 requirepass 一致。
    REDIS_PASSWORD: str = os.getenv("REDIS_PASSWORD", "")
    REDIS_DB: int = _i("REDIS_DB", 0)

    # ── 热路径鉴权/模型解析缓存 ──────────────────────────────────────────────
    # API key 校验 + 模型解析的进程内 TTL 缓存（秒）。0 = 关闭。
    # 命中时中继请求完全不查 PG；key 吊销/模型状态变更的生效延迟 = TTL。
    AUTH_CACHE_TTL_S: float = _f("AUTH_CACHE_TTL_S", 3.0)

    # ── 鉴权 ─────────────────────────────────────────────────────────────
    JWT_SECRET: str = os.getenv("JWT_SECRET", "platform-dev-only-jwt-secret-not-for-production")
    # 可恢复的上游凭据/配置使用独立 AES-256-GCM 密钥；禁止与 JWT 签名密钥复用。
    DATA_ENCRYPTION_KEY: str = os.getenv("DATA_ENCRYPTION_KEY", "").strip()
    # 管理员密码不接受配置文件/环境变量明文；首次访问管理页时写入数据库哈希。
    JWT_TTL_HOURS: int = _i("JWT_TTL_HOURS", 4)
    USER_JWT_TTL_HOURS: int = _i("USER_JWT_TTL_HOURS", 8)
    JWT_ISSUER: str = os.getenv("JWT_ISSUER", "open-api-platform").strip() or "open-api-platform"
    JWT_AUDIENCE: str = os.getenv("JWT_AUDIENCE", "open-api-platform").strip() or "open-api-platform"
    USER_SESSION_COOKIE: str = os.getenv("USER_SESSION_COOKIE", "platform_session").strip() or "platform_session"
    ADMIN_SESSION_COOKIE: str = os.getenv(
        "ADMIN_SESSION_COOKIE", "platform_admin_session"
    ).strip() or "platform_admin_session"
    SESSION_COOKIE_SECURE: bool = _b(
        "SESSION_COOKIE_SECURE",
        os.getenv("ENVIRONMENT", "production").strip().lower() == "production",
    )
    ADMIN_BOOTSTRAP_TOKEN: str = os.getenv("ADMIN_BOOTSTRAP_TOKEN", "").strip()
    # 原始数据库备份包含审计日志等个人信息，默认仅允许下载脱敏导出。
    ALLOW_ADMIN_RAW_BACKUP_DOWNLOAD: bool = _b("ALLOW_ADMIN_RAW_BACKUP_DOWNLOAD", False)
    ADMIN_SENSITIVE_ACTION_MAX_AGE_S: int = _i("ADMIN_SENSITIVE_ACTION_MAX_AGE_S", 600)
    TRUST_PROXY_HEADERS: bool = _b("TRUST_PROXY_HEADERS", False)

    # ── 自助注册 / 找回密码（可通过环境变量关闭）────────────────────────────
    ALLOW_PUBLIC_REGISTRATION: bool = _b("ALLOW_PUBLIC_REGISTRATION", False)
    ALLOW_PASSWORD_RECOVERY: bool = _b("ALLOW_PASSWORD_RECOVERY", False)

    # ── 安全演示数据 ────────────────────────────────────────────────────────
    # 开发环境默认开启；生产实例必须由部署配置显式选择。种子只会写入完全没有
    # users/api_keys 的新库，且所有演示 Key 均为不可调用的已撤销记录。
    DEMO_DATA_ENABLED: bool = _b(
        "DEMO_DATA_ENABLED",
        os.getenv("ENVIRONMENT", "production").strip().lower() != "production",
    )

    # ── 开发环境假登录（仅 ENVIRONMENT != production 生效）──────────────────
    # 本地联调可直接换取演示用户 JWT；生产环境端点固定 404。
    DEV_LOGIN_AUTH_ID: str = os.getenv("DEV_LOGIN_AUTH_ID", "demo-001")
    DEV_LOGIN_NAME: str = os.getenv("DEV_LOGIN_NAME", "演示开发用户")
    DEV_LOGIN_DEPARTMENT: str = os.getenv("DEV_LOGIN_DEPARTMENT", "应用研发组")

    # 新签发 API Key 的非敏感格式前缀。已有 Key 不受后续环境变量变更影响。
    API_KEY_PREFIX: str = os.getenv("API_KEY_PREFIX", "sk-platform-").strip() or "sk-platform-"

    # ── 上游（安全默认校验 TLS；自签 CA 应加入镜像信任链）─────────────────────────────
    UPSTREAM_TLS_VERIFY: bool = _b("UPSTREAM_TLS_VERIFY", True)
    UPSTREAM_CONNECT_TIMEOUT_S: float = _f("UPSTREAM_CONNECT_TIMEOUT_S", 10)
    UPSTREAM_READ_TIMEOUT_S: float = _f("UPSTREAM_READ_TIMEOUT_S", 600)

    # ── 限流（平台默认；管理员可在密钥管理中按 Key 上调/下调/设为无限）─────────
    RATE_LIMIT_RPM: int = _i("RATE_LIMIT_RPM", 600)
    RATE_LIMIT_TPM: int = _i("RATE_LIMIT_TPM", 6_000_000)
    # ── 夜间不限流窗口 ────────────────────────────────────────────────────
    # 每日 NIGHT_UNLIMITED_START 至次日 NIGHT_UNLIMITED_END（PLATFORM_TIMEZONE
    # 本地时间，支持跨午夜）内跳过所有 Key 的 RPM/TPM 检查与 TPM 预扣——白天
    # 配额留给在线业务，夜间批量任务放开跑。
    NIGHT_UNLIMITED_ENABLED: bool = _b("NIGHT_UNLIMITED_ENABLED", True)
    NIGHT_UNLIMITED_START: str = os.getenv("NIGHT_UNLIMITED_START", "19:00")
    NIGHT_UNLIMITED_END: str = os.getenv("NIGHT_UNLIMITED_END", "07:30")
    # 平台业务时区：夜间窗口判定所用的本地时间。
    # 容器内系统时区是 UTC，不能直接用 datetime.now()。
    PLATFORM_TIMEZONE: str = os.getenv("PLATFORM_TIMEZONE", "Asia/Shanghai")
    # 「高并发」预设档（admin 后台一键提升；仅是 RPM/TPM 数值快捷方式，不引入档位调度逻辑）
    RATE_LIMIT_HIGH_RPM: int = _i("RATE_LIMIT_HIGH_RPM", 3_000)
    RATE_LIMIT_HIGH_TPM: int = _i("RATE_LIMIT_HIGH_TPM", 60_000_000)
    # 单 Key 的 rpm_limit/tpm_limit 语义：None=平台默认；负数(-1)=无限（不限速）；>0=该值。

    def rate_limit_presets(self) -> list[dict]:
        """并发档位预设，供 admin 后台一键套用（数值集中在此，前端不硬编码）。

        rpm/tpm 一律用 **写入层语义**（-1=无限，>0=该值），可直接作为
        `POST /api/admin/keys/{id}/limits` 的入参——曾经这里用 0 占位表示无限，
        与写入层"0=回落默认"的含义相反，照字面用就会静默降速。
        """
        return [
            {"key": "default", "name": "平台默认", "rpm": self.RATE_LIMIT_RPM,
             "tpm": self.RATE_LIMIT_TPM, "unlimited": False},
            {"key": "high", "name": "高并发", "rpm": self.RATE_LIMIT_HIGH_RPM,
             "tpm": self.RATE_LIMIT_HIGH_TPM, "unlimited": False},
            {"key": "unlimited", "name": "超高并发", "rpm": -1,
             "tpm": -1, "unlimited": True},
        ]

    def key_tier(self, rpm_limit: int | None, tpm_limit: int | None) -> str:
        """按写入层语义归并密钥档位：default | high | unlimited | custom。

        与 `_key_upgradable` 同源：任一一维 -1（不限速）即超高并发；两维都
        不低于高并发预设（>=）即视为 high——包含恰好等于预设与已超出预设两种
        情况，避免"再升级"反而把某个维度拉低；两者都留空（平台默认）视为
        default；其余混档为 custom。前端据此决定是否展示「升级高并发」入口。
        """
        if rpm_limit == -1 or tpm_limit == -1:
            return "unlimited"
        if (rpm_limit is not None and rpm_limit >= self.RATE_LIMIT_HIGH_RPM
                and tpm_limit is not None and tpm_limit >= self.RATE_LIMIT_HIGH_TPM):
            return "high"
        if rpm_limit is None and tpm_limit is None:
            return "default"
        return "custom"

    # ── 用量 ──────────────────────────────────────────────────────────────
    # 仅影响 usage_logs 明细（错误详情、响应预览等排查用字段）；调用次数/Token 等统计数据
    # 已落入永久汇总表 usage_daily_summary，不受此项影响，可安全调短。
    USAGE_LOG_RETENTION_DAYS: int = _i("USAGE_LOG_RETENTION_DAYS", 90)
    # Session 画像默认保留半年；0 仅用于部署方明确选择永久保留的场景。
    USAGE_PROFILE_RETENTION_DAYS: int = _i("USAGE_PROFILE_RETENTION_DAYS", 180)
    # 响应预览/上游错误细节可能包含用户内容，开源默认只记录结构化状态和计量。
    USAGE_CONTENT_LOGGING_ENABLED: bool = _b("USAGE_CONTENT_LOGGING_ENABLED", False)
    # DB 故障时的本地耐久日志目录。容器部署必须把该目录挂到持久卷；目录中记录
    # 以 usage_logs.id 作为稳定事件 ID，恢复重放由数据库唯一主键保证幂等。
    USAGE_FAILOVER_DIR: str = os.getenv("USAGE_FAILOVER_DIR", "/var/lib/apiplatform/usage").strip()

    # ── 生产进程 ────────────────────────────────────────────────────────────
    GUNICORN_WORKERS: int = _i("GUNICORN_WORKERS", 4)
    # SQLAlchemy 池也是每 worker 一份。默认总预算为 (8+4)*4=48，给 PostgreSQL
    # 的运维、迁移、备份和后台任务留出足够余量。
    DB_POOL_SIZE: int = _i("DB_POOL_SIZE", 8)
    DB_MAX_OVERFLOW: int = _i("DB_MAX_OVERFLOW", 4)
    DB_POOL_TIMEOUT_S: int = _i("DB_POOL_TIMEOUT_S", 30)
    # 同一数据库上的 backend 副本数；横向扩容时必须同步设置，启动会按数据库
    # 实际 SHOW max_connections 校验总连接预算。
    DB_APP_INSTANCES: int = _i("DB_APP_INSTANCES", 1)
    DB_CONNECTION_RESERVE: int = _i("DB_CONNECTION_RESERVE", 32)
    # httpx 上游连接池。连接数是每 worker 的上限，默认值按四 worker 的常规部署
    # 保守设置；超大部署应通过压测显式覆盖，而不是让每个 worker 默认打开上万连接。
    HTTPX_MAX_CONNECTIONS: int = _i("HTTPX_MAX_CONNECTIONS", 256)
    HTTPX_MAX_KEEPALIVE: int = _i("HTTPX_MAX_KEEPALIVE", 64)

    # 匿名平台状态聚合会扫描多个汇总/明细索引；短 TTL 兼顾近实时展示与抗突发。
    PUBLIC_STATUS_CACHE_TTL_S: int = _i("PUBLIC_STATUS_CACHE_TTL_S", 10)
    PUBLIC_STATUS_QUERY_TIMEOUT_MS: int = _i("PUBLIC_STATUS_QUERY_TIMEOUT_MS", 3000)
    PUBLIC_STATUS_RATE_PER_MINUTE: int = _i("PUBLIC_STATUS_RATE_PER_MINUTE", 120)

    # ── 运营巡检 / 报告 ────────────────────────────────────────────────────
    OPS_REPORT_ENABLED: bool = _b("OPS_REPORT_ENABLED", False)
    OPS_REPORT_RUN_HOUR: int = _i("OPS_REPORT_RUN_HOUR", 1)        # 每日巡检触发的本地小时（生成昨日日报）
    OPS_REPORT_CHECK_INTERVAL_S: int = _i("OPS_REPORT_CHECK_INTERVAL_S", 1800)  # 巡检调度轮询间隔
    OPS_REPORT_BACKFILL_DAYS: int = _i("OPS_REPORT_BACKFILL_DAYS", 0)  # 首启回补缺失日报的天数（0=不回补）
    # 异常识别阈值
    OPS_ERROR_RATE_WARN: float = _f("OPS_ERROR_RATE_WARN", 5.0)     # 整体错误率预警(%)
    OPS_ERROR_RATE_CRITICAL: float = _f("OPS_ERROR_RATE_CRITICAL", 20.0)  # 整体错误率严重(%)
    OPS_SURGE_PCT: float = _f("OPS_SURGE_PCT", 100.0)              # 调用/Token 环比突增(%)
    OPS_DROP_PCT: float = _f("OPS_DROP_PCT", 50.0)                 # 调用量环比骤降(%)
    OPS_MODEL_MIN_REQUESTS: int = _i("OPS_MODEL_MIN_REQUESTS", 10)  # 单模型纳入错误率判定的最小样本
    OPS_MODEL_ERROR_RATE_WARN: float = _f("OPS_MODEL_ERROR_RATE_WARN", 30.0)  # 单模型错误率预警(%)
    OPS_PEAK_SHARE_PCT: float = _f("OPS_PEAK_SHARE_PCT", 40.0)     # 峰值时段集中度(%)
    OPS_PROJECT_SHARE_PCT: float = _f("OPS_PROJECT_SHARE_PCT", 60.0)  # 单项目 Token 占比集中(%)
    OPS_LATENCY_WARN_MS: int = _i("OPS_LATENCY_WARN_MS", 15000)    # 平均时延预警(ms)
    # 容量饱和体检：网关不做并发准入（2026-07 移除），TTFT 膨胀比是引擎侧
    # 过载的唯一网关可见信号，判定原则见 docs/scheduling.md
    OPS_SATURATION_INFLATION_WARN: float = _f("OPS_SATURATION_INFLATION_WARN", 4.0)  # 高峰/低谷时延中位数膨胀比
    OPS_REPORT_TIMEZONE: str = os.getenv("OPS_REPORT_TIMEZONE", "Asia/Shanghai")

    # ── Redis 依赖 ────────────────────────────────────────────────────────
    # production 默认 Redis 不可达则拒绝启动；限流在 Redis 异常时 fail-open 放行。
    REDIS_REQUIRED_ON_STARTUP: bool = _b(
        "REDIS_REQUIRED_ON_STARTUP",
        os.getenv("ENVIRONMENT", "production").strip().lower() == "production",
    )

    # ── 平台累计统计基线（叠加在日汇总实时计数之上）──────────────────────────
    # 版本升级过程中明细/汇总可能有出入；首页与管理看板累计 = 基线 + 库内实时值
    PLATFORM_STATS_INITIAL_CALLS: int = _i("PLATFORM_STATS_INITIAL_CALLS", 0)
    PLATFORM_STATS_INITIAL_TOKENS: int = _i("PLATFORM_STATS_INITIAL_TOKENS", 0)
    PLATFORM_STATS_INITIAL_COST: float = _f("PLATFORM_STATS_INITIAL_COST", 0.0)  # ¥

settings = Settings()

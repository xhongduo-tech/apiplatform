"""SQLAlchemy engine / session / Base。"""
from __future__ import annotations

import logging

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

log = logging.getLogger("apiplatform.db")


class Base(DeclarativeBase):
    pass


engine = create_engine(
    settings.DATABASE_URL,
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_recycle=3600,
    pool_pre_ping=True,
    pool_timeout=settings.DB_POOL_TIMEOUT_S,
    future=True,
    # 保持 TCP 长连接活跃，防止空闲连接被中间设备（防火墙等）静默断开
    connect_args={
        "connect_timeout": 10,
        "keepalives": 1,
        "keepalives_idle": 30,
        "keepalives_interval": 10,
        "keepalives_count": 5,
    },
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def validate_connection_budget() -> None:
    """按数据库实际上限验证所有 worker/副本的最坏连接预算。"""
    values = {
        "DB_POOL_SIZE": settings.DB_POOL_SIZE,
        "DB_MAX_OVERFLOW": settings.DB_MAX_OVERFLOW,
        "DB_POOL_TIMEOUT_S": settings.DB_POOL_TIMEOUT_S,
        "GUNICORN_WORKERS": settings.GUNICORN_WORKERS,
        "DB_APP_INSTANCES": settings.DB_APP_INSTANCES,
        "DB_CONNECTION_RESERVE": settings.DB_CONNECTION_RESERVE,
    }
    invalid = [name for name, value in values.items() if value < 0]
    if settings.DB_POOL_SIZE < 1:
        invalid.append("DB_POOL_SIZE")
    if settings.GUNICORN_WORKERS < 1:
        invalid.append("GUNICORN_WORKERS")
    if settings.DB_APP_INSTANCES < 1:
        invalid.append("DB_APP_INSTANCES")
    if settings.DB_POOL_TIMEOUT_S < 1:
        invalid.append("DB_POOL_TIMEOUT_S")
    if invalid:
        raise RuntimeError("数据库连接预算配置必须为正值：" + "、".join(sorted(set(invalid))))

    with engine.connect() as conn:
        max_connections = int(conn.execute(text("SHOW max_connections")).scalar_one())
    application_budget = (
        (settings.DB_POOL_SIZE + settings.DB_MAX_OVERFLOW)
        * settings.GUNICORN_WORKERS
        * settings.DB_APP_INSTANCES
    )
    total_budget = application_budget + settings.DB_CONNECTION_RESERVE
    if total_budget > max_connections:
        raise RuntimeError(
            "数据库连接预算超过 PostgreSQL 上限："
            f"应用最坏 {application_budget} + 预留 {settings.DB_CONNECTION_RESERVE} "
            f"> max_connections {max_connections}。请降低 DB_POOL_SIZE/DB_MAX_OVERFLOW/"
            "GUNICORN_WORKERS，或正确设置 DB_APP_INSTANCES 并扩容数据库。"
        )
    log.info(
        "数据库连接预算校验通过: application=%d reserve=%d max_connections=%d",
        application_budget, settings.DB_CONNECTION_RESERVE, max_connections,
    )


def get_db():
    """FastAPI 依赖：每请求一个 session。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _ensure_api_keys_schema() -> None:
    """兼容旧库/旧数据卷：唯一约束从 api_key 迁移到 key_hash，api_key 改为可空。

    在每次启动时幂等执行，确保即使 Alembic 跳步（旧卷残留、入口被跳过），最后
    落地的表结构与 ORM 模型一致。全部操作用 engine.begin() 包在事务里，中途
    异常自动回滚，不残留半迁移状态。
    """
    insp = inspect(engine)
    if "api_keys" not in insp.get_table_names():
        return

    cols = {c["name"]: c for c in insp.get_columns("api_keys")}
    indexes = insp.get_indexes("api_keys")

    with engine.begin() as conn:
        # 1. 删除 api_key 上的旧 unique 索引/约束（幂等）
        if "api_key" in cols:
            for idx in indexes:
                if idx.get("unique") and "api_key" in idx.get("column_names", []):
                    conn.execute(
                        text(f"DROP INDEX IF EXISTS {idx['name']}")
                    )
            # 也可能以 UniqueConstraint 形式存在
            try:
                constraints = insp.get_unique_constraints("api_keys")
                for cst in constraints:
                    if "api_key" in cst.get("column_names", []):
                        conn.execute(
                            text(f"ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS {cst['name']}")
                        )
            except NotImplementedError:
                pass

        # 2. key_hash 添加 unique index（幂等：不存在才建）
        if "key_hash" in cols:
            has_hash_unique = any(
                idx.get("unique") and "key_hash" in idx.get("column_names", [])
                for idx in indexes
            )
            if not has_hash_unique:
                conn.execute(
                    text("CREATE UNIQUE INDEX IF NOT EXISTS ix_api_keys_key_hash ON api_keys (key_hash)")
                )

        # 3. api_key 改为可空
        api_key_col = cols.get("api_key")
        if api_key_col and not api_key_col.get("nullable", True):
            conn.execute(
                text("ALTER TABLE api_keys ALTER COLUMN api_key DROP NOT NULL")
            )
            log.info("migrated api_keys.api_key -> nullable")


#: 应用启动时要求已存在的核心表。缺任何一张都说明迁移没跑到位，
#: 与其让平台带着残缺结构上线、等第一个请求 500，不如启动就失败。
_REQUIRED_TABLES = ("users", "api_keys", "model_registry", "usage_logs")


def _verify_schema() -> None:
    """生产环境只校验、不改结构。"""
    missing = sorted(set(_REQUIRED_TABLES) - set(inspect(engine).get_table_names()))
    if not missing:
        return
    raise RuntimeError(
        "数据库缺少核心表：" + "、".join(missing) + "。\n"
        "  表结构由 Alembic 负责，应用不会自行创建。请先执行迁移：\n"
        "    alembic upgrade head\n"
        "  容器部署时该命令在 entrypoint.sh 里，启动失败请查容器日志。\n"
        "  若是全新数据库，请先执行 alembic upgrade head 完成表结构初始化。"
    )


def init_db() -> None:
    """开发环境建表兜底；生产环境一律不碰表结构。

    生产上曾经也走 create_all() + ALTER TABLE，问题有二：

    1. create_all() 会掩盖「忘了写迁移」。新加了 ORM 模型却没配套迁移时，
       它在开发和生产都会把表悄悄建出来，迁移链留下空洞——直到有人从零
       部署、只跑 alembic，才发现少表。016 那次全新库起不来就是同一类问题。
    2. 表结构的权威来源必须唯一：alembic 与应用两处都能改就一定会漂移。

    因此生产只做校验：缺表就带着可执行的指引直接失败，而不是自作主张补上。
    开发（dev.sh 注入 ENVIRONMENT=development）不跑 alembic，保留兜底建表。
    """
    from app import models  # noqa: F401  确保 ORM 已注册

    if settings.ENVIRONMENT == "production":
        _verify_schema()
        return

    Base.metadata.create_all(bind=engine)
    _ensure_api_keys_schema()
    # 开发兜底补种默认场景分类（迁移 022 的守卫在全新库上会跳过，见 catalog_seed.seed_scene_types）。
    # 幂等：只填缺失的默认 key，管理员已改动的行不受影响。生产由 main.py 启动种子执行。
    from app.catalog_seed import seed_scene_types

    with SessionLocal() as db:
        seed_scene_types(db)
        db.commit()

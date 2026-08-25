"""在 PostgreSQL advisory lock 保护下执行 Alembic 迁移。

多个 backend 容器可同时启动，但任一时刻只允许一个迁移进程修改 schema。锁由
独立 psycopg session 持有；进程退出或连接断开时 PostgreSQL 会自动释放。
"""
from __future__ import annotations

import os

import psycopg
from alembic import command
from alembic.config import Config


# "APIMIGR" 的稳定 64-bit 范围整数表示；只用于本应用内协调。
MIGRATION_ADVISORY_LOCK_ID = 0x4150494D494752


def _psycopg_url(sqlalchemy_url: str) -> str:
    return sqlalchemy_url.replace("postgresql+psycopg://", "postgresql://", 1)


def upgrade_head(*, database_url: str | None = None, config_path: str = "alembic.ini") -> None:
    url = (database_url or os.getenv("DATABASE_URL", "")).strip()
    if not url:
        raise RuntimeError("缺少 DATABASE_URL，无法执行数据库迁移")

    # Alembic 使用自己的连接；此 session 只负责持有全局锁。第二个容器会在这里
    # 等待，第一个迁移完成后再执行一次幂等的 upgrade head。
    with psycopg.connect(_psycopg_url(url), autocommit=True) as lock_conn:
        lock_conn.execute("SELECT pg_advisory_lock(%s)", (MIGRATION_ADVISORY_LOCK_ID,))
        try:
            config = Config(config_path)
            config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
            command.upgrade(config, "head")
        finally:
            lock_conn.execute("SELECT pg_advisory_unlock(%s)", (MIGRATION_ADVISORY_LOCK_ID,))


def main() -> None:
    upgrade_head()


if __name__ == "__main__":
    main()

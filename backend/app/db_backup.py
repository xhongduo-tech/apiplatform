"""Generate an on-demand verified PostgreSQL custom-format snapshot."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlparse

from app.config import settings


def _database_url_for_parse() -> str:
    raw = settings.DATABASE_URL.strip()
    if raw.startswith("postgresql+psycopg://"):
        return "postgresql://" + raw[len("postgresql+psycopg://"):]
    if raw.startswith("postgresql+asyncpg://"):
        return "postgresql://" + raw[len("postgresql+asyncpg://"):]
    return raw


def pg_dump_env() -> dict[str, str]:
    """从 DATABASE_URL 解析 pg_dump 使用的 PG* 环境变量。

    SQLAlchemy 驱动名会先转换为 libpq 形式；TLS 和连接策略查询参数不能丢弃，
    否则外部 PostgreSQL 可能静默退回非预期的连接方式。
    """
    u = urlparse(_database_url_for_parse())
    env = os.environ.copy()
    env["PGHOST"] = u.hostname or "localhost"
    env["PGPORT"] = str(u.port or 5432)
    env["PGUSER"] = unquote(u.username or "platform")
    env["PGPASSWORD"] = unquote(u.password or "")
    env["PGDATABASE"] = unquote((u.path or "/").lstrip("/")) or "openapi_platform"
    query_env = {
        "application_name": "PGAPPNAME",
        "channel_binding": "PGCHANNELBINDING",
        "connect_timeout": "PGCONNECT_TIMEOUT",
        "gssencmode": "PGGSSENCMODE",
        "krbsrvname": "PGKRBSRVNAME",
        "options": "PGOPTIONS",
        "passfile": "PGPASSFILE",
        "sslcert": "PGSSLCERT",
        "sslcrl": "PGSSLCRL",
        "sslcrldir": "PGSSLCRLDIR",
        "sslkey": "PGSSLKEY",
        "sslmode": "PGSSLMODE",
        "sslpassword": "PGSSLPASSWORD",
        "sslrootcert": "PGSSLROOTCERT",
        "target_session_attrs": "PGTARGETSESSIONATTRS",
    }
    for name, value in parse_qsl(u.query, keep_blank_values=True):
        target = query_env.get(name.lower())
        if target:
            env[target] = value
    return env


def create_sql_dump() -> Path:
    """Run pg_dump and verify its table of contents; caller deletes the file.

    The historical function name remains for API compatibility, but the output
    is a compressed custom-format ``.dump`` rather than plaintext SQL.
    """
    pg_dump = shutil.which("pg_dump")
    pg_restore = shutil.which("pg_restore")
    if not pg_dump:
        raise RuntimeError("服务器未安装 pg_dump，无法生成数据库备份")
    if not pg_restore:
        raise RuntimeError("服务器未安装 pg_restore，无法验证数据库备份")

    fd, tmp_name = tempfile.mkstemp(prefix="openapi_platform_", suffix=".dump")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        proc = subprocess.run(
            [
                pg_dump,
                "--format=custom",
                "--compress=6",
                "--no-owner",
                "--no-acl",
                "-f",
                str(tmp_path),
            ],
            env=pg_dump_env(),
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip() or f"exit={proc.returncode}"
            raise RuntimeError(f"pg_dump 失败：{detail[:500]}")

        if not tmp_path.is_file() or tmp_path.stat().st_size == 0:
            raise RuntimeError("pg_dump 未生成有效备份文件")

        verify = subprocess.run(
            [pg_restore, "--list", str(tmp_path)],
            env=pg_dump_env(),
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if verify.returncode != 0:
            detail = (verify.stderr or verify.stdout or "").strip() or f"exit={verify.returncode}"
            raise RuntimeError(f"pg_dump 校验失败：{detail[:500]}")
        return tmp_path
    except subprocess.TimeoutExpired as exc:
        tmp_path.unlink(missing_ok=True)
        command = exc.cmd[0] if isinstance(exc.cmd, (list, tuple)) and exc.cmd else exc.cmd
        tool = Path(str(command)).name
        if tool == "pg_restore":
            raise RuntimeError("数据库备份校验超时（超过 1 分钟）") from None
        raise RuntimeError("数据库备份超时（超过 10 分钟）") from None
    except OSError as exc:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(f"无法启动数据库备份工具：{exc}") from exc
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

"""Read-only verification of the rotating PostgreSQL backup sidecar output."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path


_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


@lru_cache(maxsize=8)
def _verified_checksum(
    target_path: str,
    target_size: int,
    target_mtime_ns: int,
    checksum_path: str,
    checksum_size: int,
    checksum_mtime_ns: int,
) -> bool:
    """Hash an immutable snapshot once per process and file identity tuple."""
    del target_size, target_mtime_ns, checksum_size, checksum_mtime_ns
    target = Path(target_path)
    checksum = Path(checksum_path)
    try:
        fields = checksum.read_text(encoding="utf-8").strip().split()
        if len(fields) != 2 or not _SHA256_RE.fullmatch(fields[0]):
            return False
        if Path(fields[1].lstrip("*")).name != target.name:
            return False
        digest = hashlib.sha256()
        with target.open("rb") as src:
            for chunk in iter(lambda: src.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest() == fields[0].casefold()
    except (OSError, UnicodeError):
        return False


def read_backup_status(
    backup_dir: str | Path,
    *,
    interval_s: int,
    now: datetime | None = None,
    latest_name: str = "latest.dump",
) -> dict[str, object]:
    """Validate latest symlinks/checksum and report freshness.

    ``verified`` means both ``latest.dump`` and ``latest.dump.sha256`` are safe
    symlinks into the configured directory and the referenced SHA-256 matches.
    A missing or unverifiable backup is stale regardless of nominal age.
    """
    directory = Path(backup_dir)
    latest = directory / latest_name
    checksum_link = directory / f"{latest_name}.sha256"
    status: dict[str, object] = {
        "exists": False,
        "checksum_exists": False,
        "age_seconds": None,
        "verified": False,
        "stale": True,
        "size_bytes": None,
        "modified_at": None,
        "path": str(latest),
    }
    try:
        directory_resolved = directory.resolve(strict=True)
        if not latest.is_symlink():
            return status
        target = latest.resolve(strict=True)
        if target.parent != directory_resolved or not target.is_file():
            return status
        status["exists"] = True
        target_stat = target.stat()
        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        age = max(0.0, current.timestamp() - target_stat.st_mtime)
        status.update({
            "age_seconds": round(age, 3),
            "size_bytes": target_stat.st_size,
            "modified_at": datetime.fromtimestamp(
                target_stat.st_mtime, tz=timezone.utc,
            ).isoformat(),
        })
        if not checksum_link.is_symlink():
            return status
        checksum = checksum_link.resolve(strict=True)
        if checksum.parent != directory_resolved or not checksum.is_file():
            return status
        status["checksum_exists"] = True
        checksum_stat = checksum.stat()
        verified = _verified_checksum(
            str(target), target_stat.st_size, target_stat.st_mtime_ns,
            str(checksum), checksum_stat.st_size, checksum_stat.st_mtime_ns,
        )
        stale_after = max(120, int(interval_s) * 2)
        status.update({
            "verified": verified,
            "stale": (not verified) or age > stale_after,
        })
        return status
    except (OSError, ValueError):
        return status

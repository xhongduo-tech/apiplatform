from __future__ import annotations

import hashlib
import os
from datetime import datetime, timedelta, timezone

from app.backup_status import read_backup_status


def _snapshot(tmp_path, payload: bytes = b"verified postgres custom-format fixture"):
    target = tmp_path / "openapi_platform_20260824T010203Z.dump"
    checksum = tmp_path / f"{target.name}.sha256"
    target.write_bytes(payload)
    checksum.write_text(
        f"{hashlib.sha256(payload).hexdigest()}  {target.name}\n",
        encoding="utf-8",
    )
    (tmp_path / "latest.dump").symlink_to(target.name)
    (tmp_path / "latest.dump.sha256").symlink_to(checksum.name)
    return target, checksum


def test_backup_status_verifies_symlinks_checksum_and_freshness(tmp_path) -> None:
    target, _checksum = _snapshot(tmp_path)
    now = datetime.now(timezone.utc)
    os.utime(target, (now.timestamp(), now.timestamp()))

    status = read_backup_status(tmp_path, interval_s=3600, now=now)

    assert status["exists"] is True
    assert status["checksum_exists"] is True
    assert status["verified"] is True
    assert status["stale"] is False
    assert status["age_seconds"] == 0
    assert status["size_bytes"] == target.stat().st_size
    assert status["modified_at"]


def test_backup_status_marks_old_snapshot_stale(tmp_path) -> None:
    target, _checksum = _snapshot(tmp_path)
    now = datetime.now(timezone.utc)
    old = now - timedelta(seconds=7201)
    os.utime(target, (old.timestamp(), old.timestamp()))

    status = read_backup_status(tmp_path, interval_s=3600, now=now)

    assert status["verified"] is True
    assert status["stale"] is True
    assert status["age_seconds"] >= 7200


def test_backup_status_rejects_bad_checksum_and_regular_latest_file(tmp_path) -> None:
    target, checksum = _snapshot(tmp_path)
    checksum.write_text(f"{'0' * 64}  {target.name}\n", encoding="utf-8")
    status = read_backup_status(tmp_path, interval_s=3600)
    assert status["verified"] is False
    assert status["stale"] is True

    (tmp_path / "latest.dump").unlink()
    (tmp_path / "latest.dump").write_bytes(target.read_bytes())
    status = read_backup_status(tmp_path, interval_s=3600)
    assert status["exists"] is False
    assert status["verified"] is False
    assert status["stale"] is True


def test_backup_status_reports_dump_even_when_checksum_link_is_missing(tmp_path) -> None:
    target, _checksum = _snapshot(tmp_path)
    (tmp_path / "latest.dump.sha256").unlink()

    status = read_backup_status(tmp_path, interval_s=3600)

    assert status["exists"] is True
    assert status["size_bytes"] == target.stat().st_size
    assert status["checksum_exists"] is False
    assert status["verified"] is False
    assert status["stale"] is True


def test_backup_status_rejects_symlink_escape(tmp_path) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}-outside.dump"
    outside.write_bytes(b"outside")
    checksum = tmp_path / "outside.dump.sha256"
    checksum.write_text(
        f"{hashlib.sha256(b'outside').hexdigest()}  {outside.name}\n",
        encoding="utf-8",
    )
    (tmp_path / "latest.dump").symlink_to(outside)
    (tmp_path / "latest.dump.sha256").symlink_to(checksum.name)
    try:
        status = read_backup_status(tmp_path, interval_s=3600)
        assert status["verified"] is False
        assert status["stale"] is True
    finally:
        outside.unlink(missing_ok=True)

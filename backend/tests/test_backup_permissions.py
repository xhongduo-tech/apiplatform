from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


_SCRIPT = Path(__file__).resolve().parents[2] / "postgres" / "backup-loop.sh"


def _executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def test_backup_loop_publishes_group_readable_snapshots(tmp_path) -> None:
    """Exercise the real shell permission path with harmless command stubs."""
    commands = tmp_path / "bin"
    backups = tmp_path / "backups"
    commands.mkdir()
    _executable(commands / "pg_dump", """#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then
    shift
    printf 'PGDMP-test-fixture' > "$1"
    exit 0
  fi
  shift
done
exit 2
""")
    _executable(commands / "pg_restore", "#!/bin/sh\nexit 0\n")
    # The production loop sleeps after a successful first snapshot. Exiting
    # here terminates the test process after that snapshot has been published.
    _executable(commands / "sleep", "#!/bin/sh\nexit 42\n")

    env = os.environ.copy()
    env.update({
        "PATH": f"{commands}:/usr/bin:/bin:/usr/sbin:/sbin",
        "PGPASSWORD": "test-only",
        "BACKUP_DIR": str(backups),
        "BACKUP_INTERVAL_S": "60",
        "BACKUP_RETENTION_COUNT": "2",
        "BACKUP_FAILURE_RETRY_S": "10",
        "BACKUP_MAX_CONSECUTIVE_FAILURES": "1",
        # A non-root test process may chgrp only to one of its own groups.
        "BACKUP_READER_GID": str(os.getgid()),
    })
    proc = subprocess.run(
        ["/bin/sh", str(_SCRIPT)],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert proc.returncode == 42, proc.stderr

    target = (backups / "latest.dump").resolve(strict=True)
    checksum = (backups / "latest.dump.sha256").resolve(strict=True)
    assert stat.S_IMODE(backups.stat().st_mode) == 0o750
    assert stat.S_IMODE(target.stat().st_mode) == 0o640
    assert stat.S_IMODE(checksum.stat().st_mode) == 0o640
    assert target.stat().st_gid == os.getgid()
    assert checksum.stat().st_gid == os.getgid()

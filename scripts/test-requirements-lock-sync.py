#!/usr/bin/env python3
"""Regression tests for the direct-requirement/lock synchronization gate."""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check-requirements-lock.py")
SPEC = importlib.util.spec_from_file_location("requirements_lock_gate", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RequirementsLockGateTests(unittest.TestCase):
    def check_fixture(self, direct: str, lock: str) -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            direct_path = root / "requirements.txt"
            lock_path = root / "requirements.lock"
            direct_path.write_text(direct, encoding="utf-8")
            lock_path.write_text(lock, encoding="utf-8")
            return MODULE.check(direct_path, lock_path)

    def test_extras_and_normalized_names_match_base_lock_pin(self) -> None:
        self.assertEqual(
            self.check_fixture(
                "Example_Pkg[speed,tls]==1.2.3\n",
                "example-pkg==1.2.3 \\\n+    --hash=sha256:abc\ntransitive==9.0.0 \\\n+    --hash=sha256:def\n",
            ),
            [],
        )

    def test_version_drift_is_rejected(self) -> None:
        errors = self.check_fixture("example==1.2.3\n", "example==1.2.4 \\\n+    --hash=sha256:abc\n")
        self.assertEqual(len(errors), 1)
        self.assertIn("direct pin is 1.2.3", errors[0])

    def test_missing_direct_requirement_is_rejected(self) -> None:
        errors = self.check_fixture("example==1.2.3\n", "different==1.2.3\n")
        self.assertEqual(len(errors), 1)
        self.assertIn("missing", errors[0])

    def test_mutable_direct_requirement_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.check_fixture("example>=1.2.3\n", "example==1.2.3\n")


if __name__ == "__main__":
    unittest.main()

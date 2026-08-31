#!/usr/bin/env python3
"""Fail closed when a machine-readable container exception drifts or expires."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IGNORE_PATHS = {
    "CRITICAL": ROOT / "security/trivy/postgres-16-alpine-critical.yaml",
    "HIGH": ROOT / "security/trivy/postgres-16-alpine-high.yaml",
}
EXPECTED_IDS = {
    "CRITICAL": {"CVE-2025-68121"},
    "HIGH": {
        "CVE-2025-61726",
        "CVE-2025-61729",
        "CVE-2026-14456",
        "CVE-2026-25679",
        "CVE-2026-27145",
        "CVE-2026-32280",
        "CVE-2026-32281",
        "CVE-2026-32283",
        "CVE-2026-33811",
        "CVE-2026-33814",
        "CVE-2026-33818",
        "CVE-2026-39820",
        "CVE-2026-39821",
        "CVE-2026-39822",
        "CVE-2026-39836",
        "CVE-2026-42499",
        "CVE-2026-42504",
        "CVE-2026-56853",
        "CVE-2026-56858",
        "CVE-2026-56859",
        "CVE-2026-56860",
        "CVE-2026-56862",
    },
}
OPENSSL_PURLS = {
    "pkg:apk/alpine/libcrypto3@3.5.7-r0?arch=x86_64&distro=3.24.1",
    "pkg:apk/alpine/libssl3@3.5.7-r0?arch=x86_64&distro=3.24.1",
    "pkg:apk/alpine/libcrypto3@3.5.7-r0?arch=aarch64&distro=3.24.1",
    "pkg:apk/alpine/libssl3@3.5.7-r0?arch=aarch64&distro=3.24.1",
}
RECORD_PATH = ROOT / "docs/security-exceptions/SEC-2026-001-postgres-runtime.md"
COMPOSE_PATH = ROOT / "docker-compose.app.yml"
CI_PATH = ROOT / ".github/workflows/ci.yml"
EXCEPTION_ID = "SEC-2026-001"
POSTGRES_DIGEST = (
    "sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
)
MAX_EXCEPTION_DURATION = dt.timedelta(days=31)
GRAFANA_IGNORE_PATH = ROOT / "security/trivy/grafana-13.2.0-high.yaml"
GRAFANA_RECORD_PATH = ROOT / "docs/security-exceptions/SEC-2026-002-grafana-runtime.md"
GRAFANA_DIGEST = (
    "sha256:3fd54ae1214669f8355f065ec9f6445d5279a3d77095ab048ca045685272429b"
)
GRAFANA_EXCEPTION_SHA256 = (
    "05dfce081b44ca94f60cca002579198844852ed171b7f0117b80fd10853d03c6"
)
GRAFANA_EXPECTED_IDS = {
    "CVE-2026-14456",
    "CVE-2026-21728",
    "CVE-2026-25679",
    "CVE-2026-25681",
    "CVE-2026-27136",
    "CVE-2026-27145",
    "CVE-2026-28377",
    "CVE-2026-29181",
    "CVE-2026-32280",
    "CVE-2026-32281",
    "CVE-2026-32283",
    "CVE-2026-33811",
    "CVE-2026-33814",
    "CVE-2026-33818",
    "CVE-2026-39820",
    "CVE-2026-39821",
    "CVE-2026-39822",
    "CVE-2026-39836",
    "CVE-2026-39883",
    "CVE-2026-42499",
    "CVE-2026-42504",
    "CVE-2026-46600",
    "CVE-2026-56852",
    "CVE-2026-56853",
    "CVE-2026-56858",
    "CVE-2026-56859",
    "CVE-2026-56860",
    "CVE-2026-56862",
    "GHSA-hrxh-6v49-42gf",
}
TRIVY_ACTION = (
    "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25"
)
UPLOAD_ARTIFACT_ACTION = (
    "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f"
)
TRIVY_VERSION = "0.70.0"
MAX_TRIVY_DB_AGE = dt.timedelta(days=3)
FORBIDDEN_IMPLICIT_TRIVY_PATHS = (
    ROOT / ".trivyignore",
    ROOT / ".trivyignore.yaml",
    ROOT / ".trivyignore.yml",
    ROOT / "trivy.yaml",
    ROOT / "trivy.yml",
)
CONTAINER_SECURITY_JOB_SHA256 = (
    "3ab7157e6bb5fb5c385e30ed4a528732468992ccd2c0c99415b8a1177a429d2a"
)
EXPECTED_CONTAINER_SECURITY_STEPS = (
    "uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    "name: Capture unfiltered PostgreSQL HIGH and CRITICAL report",
    "name: Capture unfiltered Grafana HIGH and CRITICAL report",
    "name: Capture Trivy scanner and database metadata",
    "name: Upload unfiltered third-party vulnerability evidence",
    "name: Validate time-bounded container exceptions",
    "name: Build backend image",
    "name: Verify backend runtime boundary",
    "name: Build web image",
    "name: Verify web runtime boundary",
    "name: Scan backend image for all CRITICAL vulnerabilities",
    "name: Scan backend image for fixable HIGH vulnerabilities",
    "name: Scan web image for all CRITICAL vulnerabilities",
    "name: Scan web image for fixable HIGH vulnerabilities",
    "name: Scan PostgreSQL runtime for all CRITICAL vulnerabilities",
    "name: Scan PostgreSQL runtime for fixable HIGH vulnerabilities",
    "name: Scan Redis runtime for all CRITICAL vulnerabilities",
    "name: Scan Redis runtime for fixable HIGH vulnerabilities",
    "name: Scan Prometheus runtime for all CRITICAL vulnerabilities",
    "name: Scan Prometheus runtime for fixable HIGH vulnerabilities",
    "name: Scan Grafana runtime for all CRITICAL vulnerabilities",
    "name: Scan Grafana runtime for fixable HIGH vulnerabilities",
    "name: Generate backend SBOM",
    "name: Generate web SBOM",
)
EVIDENCE_PIPELINE_STEPS = (
    "name: Capture unfiltered PostgreSQL HIGH and CRITICAL report",
    "name: Capture unfiltered Grafana HIGH and CRITICAL report",
    "name: Capture Trivy scanner and database metadata",
    "name: Upload unfiltered third-party vulnerability evidence",
    "name: Validate time-bounded container exceptions",
)


def fail(message: str) -> None:
    raise SystemExit(f"container security exception check failed: {message}")


def validate_no_implicit_trivy_configuration() -> None:
    # Trivy auto-loads root-level config/ignore files. Such a file would also
    # affect scans whose action inputs intentionally omit an exception file,
    # making the supposedly unfiltered evidence incomplete.
    present = [
        str(path.relative_to(ROOT))
        for path in FORBIDDEN_IMPLICIT_TRIVY_PATHS
        if path.exists() or path.is_symlink()
    ]
    if present:
        fail(
            "implicit root-level Trivy configuration is forbidden; "
            f"found={present}"
        )


def workflow_job(workflow: str, name: str) -> str:
    marker = f"  {name}:\n"
    starts = [
        match.start()
        for match in re.finditer(rf"^{re.escape(marker)}", workflow, re.MULTILINE)
    ]
    if len(starts) != 1:
        fail(f"workflow must contain exactly one {name} job")
    start = starts[0]
    next_job = re.search(
        r"^  [A-Za-z0-9_-]+:\s*$", workflow[start + len(marker) :], re.MULTILINE
    )
    end = (
        start + len(marker) + next_job.start()
        if next_job is not None
        else len(workflow)
    )
    return workflow[start:end]


def workflow_step(workflow: str, name: str) -> str:
    marker = f"      - name: {name}\n"
    starts = [
        match.start()
        for match in re.finditer(rf"^{re.escape(marker)}", workflow, re.MULTILINE)
    ]
    if len(starts) != 1:
        fail(f"workflow must contain exactly one step named: {name}")
    start = starts[0]
    next_step = re.search(r"^      - ", workflow[start + len(marker) :], re.MULTILINE)
    end = (
        start + len(marker) + next_step.start()
        if next_step is not None
        else len(workflow)
    )
    return workflow[start:end]


def validate_container_security_job(workflow: str) -> str:
    # Workflow-level defaults and environment variables are inherited by jobs
    # and could silently alter the scanner CLI or shell. Keep this security job
    # independent from both mechanisms.
    for inherited_key in ("env", "defaults"):
        if re.search(
            rf"^(?:{inherited_key}|['\"]{inherited_key}['\"])\s*:",
            workflow,
            re.MULTILINE,
        ):
            fail(
                f"workflow-level {inherited_key} is forbidden because container-security inherits it"
            )

    job = workflow_job(workflow, "container-security")
    top_level_keys = re.findall(r"^    ([A-Za-z0-9_-]+):", job, re.MULTILINE)
    if top_level_keys != ["name", "runs-on", "needs", "steps"]:
        fail("container-security job keys must be exactly name, runs-on, needs, steps")

    step_headers = tuple(re.findall(r"^      - ([^\n]+)$", job, re.MULTILINE))
    if step_headers != EXPECTED_CONTAINER_SECURITY_STEPS:
        fail(
            "container-security step descriptors are missing, reordered, duplicated, or unexpected"
        )

    evidence_start = step_headers.index(EVIDENCE_PIPELINE_STEPS[0])
    if (
        step_headers[evidence_start : evidence_start + len(EVIDENCE_PIPELINE_STEPS)]
        != EVIDENCE_PIPELINE_STEPS
    ):
        fail(
            "evidence capture, metadata, upload, and validation steps must be strictly adjacent"
        )

    # This reviewed digest deliberately covers every action input and every run
    # command in the job. Besides rejecting unknown steps, it prevents an
    # existing build/verification step from being repurposed after validation
    # to rewrite exception files or append scanner overrides to GITHUB_ENV.
    actual_digest = hashlib.sha256(job.encode("utf-8")).hexdigest()
    if actual_digest != CONTAINER_SECURITY_JOB_SHA256:
        fail(
            "container-security job body changed; review the complete descriptor and update its lock"
        )
    return job


def service_block(compose: str, name: str, next_name: str) -> str:
    marker = f"\n  {name}:\n"
    next_marker = f"\n  {next_name}:\n"
    start = compose.find(marker)
    end = compose.find(next_marker, start + len(marker))
    if start < 0 or end < 0:
        fail(f"Compose service boundary is missing: {name}")
    return compose[start:end]


def field_values(block: str, key: str) -> list[str]:
    return re.findall(
        rf"^\s*{re.escape(key)}:\s*([^\s#]+)(?:\s+#.*)?$",
        block,
        re.MULTILINE,
    )


def has_service_key(block: str, key: str) -> bool:
    """Return whether a Compose service defines a direct service-level key."""
    return re.search(rf"^    {re.escape(key)}\s*:", block, re.MULTILINE) is not None


def service_sequence_values(block: str, key: str) -> list[str]:
    """Read a simple block-style sequence below one direct Compose service key."""
    headers = list(
        re.finditer(rf"^    {re.escape(key)}\s*:\s*$", block, re.MULTILINE)
    )
    if len(headers) != 1:
        fail(f"Compose service must define exactly one block-style {key} sequence")
    tail = block[headers[0].end() :]
    next_key = re.search(r"^    [A-Za-z0-9_-]+\s*:", tail, re.MULTILINE)
    sequence = tail[: next_key.start()] if next_key is not None else tail
    values = re.findall(
        r"^      -\s+([^\s#]+)(?:\s+#.*)?$", sequence, re.MULTILINE
    )
    remaining = re.sub(
        r"^(?:\s*|\s*#.*|      -\s+[^\s#]+(?:\s+#.*)?)$",
        "",
        sequence,
        flags=re.MULTILINE,
    )
    if remaining.strip() or not values:
        fail(f"Compose service {key} must be a non-empty scalar sequence")
    return values


def require_trivy_scan(
    workflow: str,
    *,
    name: str,
    image_ref: str,
    severity: str,
    ignore_unfixed: str,
    exit_code: str,
    output_format: str,
    ignore_file: str | None,
    output: str | None = None,
) -> None:
    block = workflow_step(workflow, name)
    expected = {
        "uses": TRIVY_ACTION,
        "image-ref": image_ref,
        "format": output_format,
        "exit-code": f'"{exit_code}"',
        "ignore-unfixed": ignore_unfixed,
        "severity": severity,
    }
    if output is not None:
        expected["output"] = output
    for key, value in expected.items():
        if field_values(block, key) != [value]:
            fail(f"{name} must set exactly {key}: {value}")
    if output is None and field_values(block, "output"):
        fail(f"{name} must not write an unexpected output")
    ignore_values = field_values(block, "trivyignores")
    if ignore_file is None:
        if ignore_values:
            fail(f"{name} must remain unfiltered")
    elif ignore_values != [ignore_file]:
        fail(f"{name} must use exactly one reviewed ignore file: {ignore_file}")
    expected_with_keys = set(expected) - {"uses"}
    if ignore_file is not None:
        expected_with_keys.add("trivyignores")
    actual_with_keys = re.findall(r"^ {10}([A-Za-z0-9_-]+):", block, re.MULTILINE)
    if len(actual_with_keys) != len(expected_with_keys) or set(
        actual_with_keys
    ) != expected_with_keys:
        fail(f"{name} has an unexpected, duplicate, or missing Trivy input")
    step_keys = re.findall(r"^ {8}([A-Za-z0-9_-]+):", block, re.MULTILINE)
    if step_keys != ["uses", "with"]:
        fail(f"{name} has an unexpected condition or step-level override")


def require_evidence_upload(workflow: str) -> None:
    name = "Upload unfiltered third-party vulnerability evidence"
    block = workflow_step(workflow, name)
    step_keys = re.findall(r"^ {8}([A-Za-z0-9_-]+):", block, re.MULTILINE)
    if step_keys != ["if", "uses", "with"]:
        fail(f"{name} has an unexpected, duplicate, or missing step key")
    if field_values(block, "if") != ["always()"]:
        fail(
            "unfiltered vulnerability evidence must upload even after a blocking finding"
        )
    if field_values(block, "uses") != [UPLOAD_ARTIFACT_ACTION]:
        fail("unfiltered vulnerability evidence must use the pinned upload action")

    expected_with_keys = ["name", "path", "if-no-files-found", "retention-days"]
    actual_with_keys = re.findall(r"^ {10}([A-Za-z0-9_-]+):", block, re.MULTILINE)
    if actual_with_keys != expected_with_keys:
        fail(
            "unfiltered vulnerability evidence upload has an unexpected, duplicate, "
            "or missing input"
        )
    expected_values = {
        "name": "third-party-container-vulnerability-evidence",
        "path": "|",
        "if-no-files-found": "error",
        "retention-days": "30",
    }
    for key, value in expected_values.items():
        if field_values(block, key) != [value]:
            fail(
                f"unfiltered vulnerability evidence upload must set exactly {key}: {value}"
            )

    path_match = re.search(
        r"^ {10}path:\s*\|\s*\n(?P<paths>(?: {12}[^\n]+\n?)+)",
        block,
        re.MULTILINE,
    )
    if path_match is None:
        fail("unfiltered vulnerability evidence upload must use a literal path list")
    actual_paths = tuple(line[12:] for line in path_match.group("paths").splitlines())
    if actual_paths != (
        "postgres-unfiltered-high-critical.json",
        "grafana-unfiltered-high-critical.json",
        "trivy-version.json",
    ):
        fail("unfiltered vulnerability evidence upload path list drifted")


def load_entries(severity: str, path: Path) -> list[dict[str, object]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot parse {path.relative_to(ROOT)} as JSON-compatible YAML: {exc}")
    if set(document) != {"vulnerabilities"}:
        fail(f"{severity} ignore document may contain only vulnerabilities")
    entries = document["vulnerabilities"]
    if not isinstance(entries, list) or not entries:
        fail(f"{severity} vulnerabilities must be a non-empty list")
    if not all(isinstance(entry, dict) for entry in entries):
        fail(f"{severity} entries must all be objects")
    return entries


def load_json_object(path: Path, label: str) -> dict[str, object]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot parse {label} at {path}: {exc}")
    if not isinstance(document, dict):
        fail(f"{label} must be a JSON object")
    return document


def expected_scopes(
    entries: list[dict[str, object]], architecture: str
) -> set[tuple[str, str, str]]:
    purl_arch = {"amd64": "x86_64", "arm64": "aarch64"}.get(architecture)
    if purl_arch is None:
        fail(f"unsupported Trivy evidence architecture: {architecture}")
    scopes: set[tuple[str, str, str]] = set()
    for entry in entries:
        finding_id = entry["id"]
        if not isinstance(finding_id, str):
            fail("reviewed evidence scope has a non-string finding ID")
        for purl in entry.get("purls", []):
            if isinstance(purl, str) and re.search(
                rf"(?:[?&])arch={re.escape(purl_arch)}(?:&|$)", purl
            ):
                scopes.add((finding_id, "purl", purl))
        for path in entry.get("paths", []):
            if not isinstance(path, str):
                continue
            architecture_match = re.search(r"_linux_(amd64|arm64)$", path)
            if architecture_match is None or architecture_match.group(1) == architecture:
                scopes.add((finding_id, "path", path))
    return scopes


def report_scopes(
    report: dict[str, object], *, image_ref: str, digest: str
) -> tuple[str, dict[str, set[tuple[str, str, str]]]]:
    if report.get("SchemaVersion") != 2:
        fail(f"{image_ref} evidence must use Trivy JSON schema 2")
    if report.get("ArtifactName") != image_ref:
        fail(f"Trivy evidence artifact does not match {image_ref}")
    metadata = report.get("Metadata")
    if not isinstance(metadata, dict):
        fail(f"{image_ref} evidence has no metadata object")
    repo_digests = metadata.get("RepoDigests")
    if not isinstance(repo_digests, list) or not any(
        isinstance(value, str) and value.endswith(f"@{digest}")
        for value in repo_digests
    ):
        fail(f"Trivy evidence is not bound to {digest}")
    image_config = metadata.get("ImageConfig")
    if not isinstance(image_config, dict) or image_config.get("os") != "linux":
        fail(f"{image_ref} evidence must describe a Linux image")
    architecture = image_config.get("architecture")
    if architecture not in {"amd64", "arm64"}:
        fail(f"{image_ref} evidence has an unsupported architecture")

    findings: dict[str, set[tuple[str, str, str]]] = {
        "CRITICAL": set(),
        "HIGH": set(),
    }
    results = report.get("Results")
    if not isinstance(results, list):
        fail(f"{image_ref} evidence has no results array")
    for result in results:
        if not isinstance(result, dict):
            fail(f"{image_ref} evidence contains a malformed result")
        target = result.get("Target")
        result_class = result.get("Class")
        vulnerabilities = result.get("Vulnerabilities") or []
        if not isinstance(target, str) or not isinstance(vulnerabilities, list):
            fail(f"{image_ref} evidence contains a malformed target")
        for vulnerability in vulnerabilities:
            if not isinstance(vulnerability, dict):
                fail(f"{image_ref} evidence contains a malformed vulnerability")
            severity = vulnerability.get("Severity")
            finding_id = vulnerability.get("VulnerabilityID")
            if severity not in findings or not isinstance(finding_id, str):
                fail(f"{image_ref} evidence escaped the HIGH/CRITICAL filter")
            # High gates evaluate findings that have an upstream dependency
            # fix. Critical remains fully blocking regardless of fix status.
            if severity == "HIGH" and not vulnerability.get("FixedVersion"):
                continue
            if result_class == "os-pkgs":
                identifier = vulnerability.get("PkgIdentifier")
                purl = identifier.get("PURL") if isinstance(identifier, dict) else None
                if not isinstance(purl, str):
                    fail(f"{finding_id} in {image_ref} has no package PURL")
                scope = (finding_id, "purl", purl)
            elif result_class == "lang-pkgs":
                scope = (finding_id, "path", target)
            else:
                fail(f"{finding_id} in {image_ref} has an unreviewed result class")
            # One advisory can occur through multiple Go dependency records in
            # the same bundled executable. Trivy's reviewed path scope applies
            # to that ID/path pair, so compare the de-duplicated scope set.
            findings[severity].add(scope)
    return architecture, findings


def compare_scopes(
    *,
    label: str,
    expected: set[tuple[str, str, str]],
    actual: set[tuple[str, str, str]],
) -> None:
    if expected == actual:
        return
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    fail(f"{label} evidence drifted; missing={missing[:5]}, extra={extra[:5]}")


def validate_trivy_evidence(evidence_dir: Path, now: dt.datetime) -> str:
    postgres_report = load_json_object(
        evidence_dir / "postgres-unfiltered-high-critical.json",
        "PostgreSQL Trivy evidence",
    )
    grafana_report = load_json_object(
        evidence_dir / "grafana-unfiltered-high-critical.json",
        "Grafana Trivy evidence",
    )
    version = load_json_object(
        evidence_dir / "trivy-version.json", "Trivy version evidence"
    )
    if version.get("Version") != TRIVY_VERSION:
        fail(f"Trivy evidence must use scanner {TRIVY_VERSION}")
    vulnerability_db = version.get("VulnerabilityDB")
    updated_text = (
        vulnerability_db.get("UpdatedAt")
        if isinstance(vulnerability_db, dict)
        else None
    )
    if not isinstance(updated_text, str):
        fail("Trivy evidence has no vulnerability database timestamp")
    try:
        # Trivy emits RFC3339Nano while datetime.fromisoformat on older
        # supported Python runtimes accepts at most microseconds.
        normalized_timestamp = re.sub(
            r"(\.[0-9]{6})[0-9]+(?=Z$)", r"\1", updated_text
        )
        updated_at = dt.datetime.fromisoformat(
            normalized_timestamp.replace("Z", "+00:00")
        )
    except ValueError:
        fail("Trivy vulnerability database timestamp is invalid")
    if updated_at.tzinfo is None:
        fail("Trivy vulnerability database timestamp must include a timezone")
    age = now - updated_at
    if age < -dt.timedelta(minutes=5) or age > MAX_TRIVY_DB_AGE:
        fail("Trivy vulnerability database is future-dated or more than 72 hours old")

    postgres_ref = f"postgres:16-alpine@{POSTGRES_DIGEST}"
    postgres_arch, postgres_findings = report_scopes(
        postgres_report, image_ref=postgres_ref, digest=POSTGRES_DIGEST
    )
    for severity, path in IGNORE_PATHS.items():
        compare_scopes(
            label=f"PostgreSQL {severity} {postgres_arch}",
            expected=expected_scopes(load_entries(severity, path), postgres_arch),
            actual=postgres_findings[severity],
        )

    grafana_ref = f"grafana/grafana:13.2.0@{GRAFANA_DIGEST}"
    grafana_arch, grafana_findings = report_scopes(
        grafana_report, image_ref=grafana_ref, digest=GRAFANA_DIGEST
    )
    if grafana_findings["CRITICAL"]:
        fail("Grafana unfiltered Critical evidence must remain empty")
    compare_scopes(
        label=f"Grafana HIGH {grafana_arch}",
        expected=expected_scopes(
            load_entries("Grafana HIGH", GRAFANA_IGNORE_PATH), grafana_arch
        ),
        actual=grafana_findings["HIGH"],
    )
    return updated_at.isoformat().replace("+00:00", "Z")


def validate_grafana(now: dt.datetime) -> str:
    raw = GRAFANA_IGNORE_PATH.read_bytes()
    if hashlib.sha256(raw).hexdigest() != GRAFANA_EXCEPTION_SHA256:
        fail("Grafana exception content changed without updating its reviewed checksum")
    entries = load_entries("Grafana HIGH", GRAFANA_IGNORE_PATH)
    ids: set[str] = set()
    expiries: set[dt.datetime] = set()
    plugin_path = re.compile(
        r"usr/share/grafana/data/plugins-bundled/.+_linux_(amd64|arm64)$"
    )
    for index, entry in enumerate(entries, 1):
        if set(entry) != {"id", "paths", "expired_at", "statement"} and set(
            entry
        ) != {"id", "purls", "expired_at", "statement"}:
            fail(f"Grafana HIGH entry {index} has missing or unexpected keys")
        finding_id = entry["id"]
        if not isinstance(finding_id, str) or not re.fullmatch(
            r"(?:CVE-[0-9]{4}-[0-9]{4,}|GHSA-[a-z0-9-]+)", finding_id
        ):
            fail(f"Grafana HIGH entry {index} has an invalid finding ID")
        if finding_id in ids:
            fail(f"duplicate Grafana HIGH exception for {finding_id}")
        ids.add(finding_id)

        expiry_text = entry["expired_at"]
        if not isinstance(expiry_text, str) or not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z",
            expiry_text,
        ):
            fail(f"Grafana HIGH entry {index} must use an RFC3339 UTC expiry")
        try:
            expiry = dt.datetime.fromisoformat(expiry_text.replace("Z", "+00:00"))
        except ValueError:
            fail(f"Grafana HIGH entry {index} has an invalid expiry")
        if expiry < now or expiry - now > MAX_EXCEPTION_DURATION:
            fail(f"{finding_id} has expired or exceeds the 31-day maximum")
        expiries.add(expiry)

        statement = entry["statement"]
        if not isinstance(statement, str) or "SEC-2026-002" not in statement:
            fail(f"{finding_id} does not link to SEC-2026-002")
        if finding_id == "CVE-2026-14456":
            if set(entry.get("purls", [])) != OPENSSL_PURLS or "paths" in entry:
                fail("Grafana OpenSSL exception must use the four reviewed APK PURLs")
        else:
            paths = entry.get("paths")
            if "purls" in entry or not isinstance(paths, list) or not paths:
                fail(f"{finding_id} must use exact bundled-binary paths")
            if len(paths) != len(set(paths)) or not all(
                isinstance(path, str) and plugin_path.fullmatch(path) for path in paths
            ):
                fail(f"{finding_id} has a duplicate or over-broad plugin path")
            path_set = set(paths)
            for path in paths:
                peer = re.sub(
                    r"_linux_(?:amd64|arm64)$",
                    "_linux_arm64" if path.endswith("_linux_amd64") else "_linux_amd64",
                    path,
                )
                if peer not in path_set:
                    fail(f"{finding_id} does not scope both supported architectures")

    if ids != GRAFANA_EXPECTED_IDS:
        fail(
            "Grafana HIGH ID set drifted; "
            f"missing={sorted(GRAFANA_EXPECTED_IDS - ids)}, "
            f"extra={sorted(ids - GRAFANA_EXPECTED_IDS)}"
        )
    if len(expiries) != 1:
        fail("all Grafana findings must share one expiry timestamp")
    expiry_text = next(iter(expiries)).isoformat().replace("+00:00", "Z")

    record = GRAFANA_RECORD_PATH.read_text(encoding="utf-8")
    for required in (
        "SEC-2026-002",
        GRAFANA_DIGEST,
        expiry_text,
        str(GRAFANA_IGNORE_PATH.relative_to(ROOT)),
        "## Risk impact and exposure",
        "## Temporary treatment",
        "### Detection and alerting",
        "### Rollback or containment",
        "### Verification evidence and test date",
        "### Reassessment cadence",
    ):
        if required not in record:
            fail(f"Grafana human record is missing {required}")

    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    grafana_block = service_block(compose, "grafana", "nginx")
    if grafana_block.count(GRAFANA_DIGEST) != 1:
        fail("the excepted Grafana digest must appear once in the Grafana service")
    for required in (
        'GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION: "${GRAFANA_DISABLE_INITIAL_ADMIN_CREATION:-true}"',
        'GF_AUTH_ANONYMOUS_ENABLED: "${GRAFANA_ANONYMOUS_ENABLED:-false}"',
        'GF_ANALYTICS_REPORTING_ENABLED: "false"',
        'GF_ANALYTICS_CHECK_FOR_UPDATES: "false"',
        'GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false"',
        'GF_NEWS_NEWS_FEED_ENABLED: "false"',
        'GF_PLUGINS_PLUGIN_ADMIN_ENABLED: "false"',
        'GF_PLUGINS_PREINSTALL_DISABLED: "true"',
        'GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED: "true"',
        './monitoring/grafana/provisioning:/etc/grafana/provisioning:ro',
        './monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro',
        '"${GRAFANA_BIND_ADDRESS:-127.0.0.1}:${GRAFANA_PORT:-3000}:3000"',
        "read_only: true",
        "no-new-privileges:true",
        "cap_drop:",
        "- ALL",
    ):
        if required not in grafana_block:
            fail(f"Grafana compensating control is missing: {required}")
    if has_service_key(grafana_block, "cap_add"):
        fail("Grafana compensating control forbids every added capability")
    datasource = (
        ROOT / "monitoring/grafana/provisioning/datasources/prometheus.yml"
    ).read_text(encoding="utf-8")
    for required in (
        "type: prometheus",
        "url: http://prometheus:9090",
        "isDefault: true",
        "editable: false",
    ):
        if datasource.count(required) != 1:
            fail(f"Grafana datasource boundary is missing or duplicated: {required}")
    if datasource.count("  - name:") != 1:
        fail("the shipped Grafana provisioning must contain exactly one datasource")

    ci = CI_PATH.read_text(encoding="utf-8")
    container_security_job = workflow_job(ci, "container-security")
    relative = str(GRAFANA_IGNORE_PATH.relative_to(ROOT))
    image_ref = f"grafana/grafana:13.2.0@{GRAFANA_DIGEST}"
    require_trivy_scan(
        container_security_job,
        name="Capture unfiltered Grafana HIGH and CRITICAL report",
        image_ref=image_ref,
        severity="HIGH,CRITICAL",
        ignore_unfixed="false",
        exit_code="0",
        output_format="json",
        output="grafana-unfiltered-high-critical.json",
        ignore_file=None,
    )
    require_trivy_scan(
        container_security_job,
        name="Scan Grafana runtime for all CRITICAL vulnerabilities",
        image_ref=image_ref,
        severity="CRITICAL",
        ignore_unfixed="false",
        exit_code="1",
        output_format="table",
        ignore_file=None,
    )
    require_trivy_scan(
        container_security_job,
        name="Scan Grafana runtime for fixable HIGH vulnerabilities",
        image_ref=image_ref,
        severity="HIGH",
        ignore_unfixed="true",
        exit_code="1",
        output_format="table",
        ignore_file=relative,
    )
    if ci.count(f"trivyignores: {relative}") != 1:
        fail("the Grafana exception file must be referenced exactly once in CI")
    return expiry_text


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate time-bounded container security exceptions."
    )
    parser.add_argument(
        "--evidence-dir",
        type=Path,
        help="also compare unfiltered Trivy JSON reports to every reviewed scope",
    )
    args = parser.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    validate_no_implicit_trivy_configuration()
    ci = CI_PATH.read_text(encoding="utf-8")
    container_security_job = validate_container_security_job(ci)
    grafana_expiry = validate_grafana(now)
    expiries: set[dt.datetime] = set()

    for severity, path in IGNORE_PATHS.items():
        entries = load_entries(severity, path)
        actual_ids: set[str] = set()
        for index, entry in enumerate(entries, 1):
            allowed = {"id", "paths", "purls", "expired_at", "statement"}
            required = {"id", "expired_at", "statement"}
            if set(entry) - allowed or not required <= set(entry):
                fail(f"{severity} entry {index} has missing or unexpected keys")

            vulnerability_id = entry["id"]
            if not isinstance(vulnerability_id, str) or not re.fullmatch(
                r"CVE-[0-9]{4}-[0-9]{4,}", vulnerability_id
            ):
                fail(f"{severity} entry {index} has an invalid CVE identifier")
            if vulnerability_id in actual_ids:
                fail(f"duplicate {severity} exception for {vulnerability_id}")
            actual_ids.add(vulnerability_id)

            expiry_text = entry["expired_at"]
            if not isinstance(expiry_text, str) or not re.fullmatch(
                r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z",
                expiry_text,
            ):
                fail(f"{severity} entry {index} must use an RFC3339 UTC expiry")
            try:
                expiry = dt.datetime.fromisoformat(expiry_text.replace("Z", "+00:00"))
            except ValueError:
                fail(f"{severity} entry {index} has an invalid expiry")
            if expiry < now:
                fail(f"{vulnerability_id} expired at {expiry_text}")
            if expiry - now > MAX_EXCEPTION_DURATION:
                fail(f"{vulnerability_id} exceeds the 31-day maximum")
            expiries.add(expiry)

            statement = entry["statement"]
            if not isinstance(statement, str) or EXCEPTION_ID not in statement:
                fail(f"{vulnerability_id} does not link to {EXCEPTION_ID}")
            paths = entry.get("paths")
            purls = entry.get("purls")
            if vulnerability_id == "CVE-2026-14456":
                if (
                    paths is not None
                    or not isinstance(purls, list)
                    or set(purls) != OPENSSL_PURLS
                ):
                    fail(f"{vulnerability_id} must use the four reviewed APK PURLs")
            elif paths != ["usr/local/bin/gosu"] or purls is not None:
                fail(f"{vulnerability_id} must be scoped only to usr/local/bin/gosu")

        if actual_ids != EXPECTED_IDS[severity]:
            missing = sorted(EXPECTED_IDS[severity] - actual_ids)
            extra = sorted(actual_ids - EXPECTED_IDS[severity])
            fail(f"{severity} ID set drifted; missing={missing}, extra={extra}")

    if EXPECTED_IDS["CRITICAL"] & EXPECTED_IDS["HIGH"]:
        fail("a CVE cannot be suppressed in more than one severity gate")
    if len(expiries) != 1:
        fail("all findings in this record must share one expiry timestamp")

    record = RECORD_PATH.read_text(encoding="utf-8")
    expiry_text = next(iter(expiries)).isoformat().replace("+00:00", "Z")
    for required in (
        EXCEPTION_ID,
        POSTGRES_DIGEST,
        expiry_text,
        "## Risk impact and exposure",
        "## Temporary treatment",
        "### Detection and alerting",
        "### Rollback or containment",
        "### Verification evidence and test date",
        "### Reassessment cadence",
    ):
        if required not in record:
            fail(f"human record is missing {required}")
    for path in IGNORE_PATHS.values():
        if str(path.relative_to(ROOT)) not in record:
            fail(f"human record does not link {path.relative_to(ROOT)}")

    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    postgres_block = service_block(compose, "postgres", "pg-backup")
    backup_block = service_block(compose, "pg-backup", "redis")
    redis_block = service_block(compose, "redis", "backend")
    prometheus_block = service_block(compose, "prometheus", "grafana")
    if postgres_block.count(POSTGRES_DIGEST) != 1 or backup_block.count(
        POSTGRES_DIGEST
    ) != 1:
        fail("database and backup services must each use the excepted digest once")
    for required in (
        'user: "70:70"',
        "/var/run/postgresql:size=16m,uid=70,gid=70,mode=3775",
        "no-new-privileges:true",
        "cap_drop:",
        "- ALL",
        "read_only: true",
    ):
        if required not in postgres_block:
            fail(f"PostgreSQL compensating control is missing: {required}")
    if has_service_key(postgres_block, "cap_add"):
        fail("PostgreSQL compensating control forbids every added capability")
    for required in (
        'entrypoint: ["/bin/sh", "/backup-loop.sh"]',
        "no-new-privileges:true",
        "cap_drop:",
        "- ALL",
        "cap_add:",
        "- CHOWN",
        "read_only: true",
    ):
        if required not in backup_block:
            fail(f"backup compensating control is missing: {required}")
    if service_sequence_values(backup_block, "cap_add") != ["CHOWN"]:
        fail("backup compensating control permits only CAP_CHOWN")
    for required in (
        'user: "999:1000"',
        "/tmp:size=32m,mode=1777",
        "no-new-privileges:true",
        "cap_drop:",
        "- ALL",
        "read_only: true",
    ):
        if required not in redis_block:
            fail(f"Redis runtime control is missing: {required}")
    if has_service_key(redis_block, "cap_add"):
        fail("Redis runtime control forbids every added capability")
    if has_service_key(prometheus_block, "cap_add"):
        fail("Prometheus runtime control forbids every added capability")

    image_ref = f"postgres:16-alpine@{POSTGRES_DIGEST}"
    require_trivy_scan(
        container_security_job,
        name="Capture unfiltered PostgreSQL HIGH and CRITICAL report",
        image_ref=image_ref,
        severity="HIGH,CRITICAL",
        ignore_unfixed="false",
        exit_code="0",
        output_format="json",
        output="postgres-unfiltered-high-critical.json",
        ignore_file=None,
    )
    require_trivy_scan(
        container_security_job,
        name="Scan PostgreSQL runtime for all CRITICAL vulnerabilities",
        image_ref=image_ref,
        severity="CRITICAL",
        ignore_unfixed="false",
        exit_code="1",
        output_format="table",
        ignore_file=str(IGNORE_PATHS["CRITICAL"].relative_to(ROOT)),
    )
    require_trivy_scan(
        container_security_job,
        name="Scan PostgreSQL runtime for fixable HIGH vulnerabilities",
        image_ref=image_ref,
        severity="HIGH",
        ignore_unfixed="true",
        exit_code="1",
        output_format="table",
        ignore_file=str(IGNORE_PATHS["HIGH"].relative_to(ROOT)),
    )
    for path in IGNORE_PATHS.values():
        relative = str(path.relative_to(ROOT))
        if ci.count(f"trivyignores: {relative}") != 1:
            fail(f"{relative} must be referenced exactly once in CI")

    require_evidence_upload(container_security_job)
    metadata_step = workflow_step(
        container_security_job, "Capture Trivy scanner and database metadata"
    )
    if metadata_step.splitlines() != [
        "      - name: Capture Trivy scanner and database metadata",
        "        run: trivy version --format json > trivy-version.json",
    ]:
        fail("Trivy evidence must record scanner and vulnerability DB metadata")
    evidence_steps = (
        "Capture unfiltered PostgreSQL HIGH and CRITICAL report",
        "Capture unfiltered Grafana HIGH and CRITICAL report",
        "Capture Trivy scanner and database metadata",
        "Upload unfiltered third-party vulnerability evidence",
    )
    evidence_positions = [
        container_security_job.index(f"      - name: {name}\n")
        for name in evidence_steps
    ]
    if evidence_positions != sorted(evidence_positions):
        fail("unfiltered reports, metadata, and upload must remain in evidence order")
    first_blocking_scan = container_security_job.index(
        "      - name: Scan backend image for all CRITICAL vulnerabilities\n"
    )
    validation = container_security_job.index(
        "      - name: Validate time-bounded container exceptions\n"
    )
    if evidence_positions[-1] > min(first_blocking_scan, validation):
        fail("unfiltered evidence must upload before validation and every blocking scan")

    validation_step = workflow_step(
        container_security_job, "Validate time-bounded container exceptions"
    )
    if validation_step.splitlines() != [
        "      - name: Validate time-bounded container exceptions",
        "        run: python3 scripts/check-container-security-exceptions.py --evidence-dir .",
    ]:
        fail("CI must compare the unfiltered reports with the reviewed scopes")

    if args.evidence_dir is not None:
        database_timestamp = validate_trivy_evidence(args.evidence_dir, now)
        print(
            "unfiltered Trivy evidence: exact architecture scopes verified; "
            f"database updated {database_timestamp}"
        )

    print(
        f"container exception {EXCEPTION_ID}: 1 Critical and 22 High CVE IDs, "
        f"expires {expiry_text}; exact digest and compensating controls verified"
    )
    print(
        "container exception SEC-2026-002: 29 High finding IDs, "
        f"expires {grafana_expiry}; exact digest and compensating controls verified"
    )


if __name__ == "__main__":
    main()

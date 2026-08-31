# SEC-2026-001 — PostgreSQL upstream runtime findings

This is a time-bounded release exception, not a statement that the scanner is
wrong or that the affected packages have been patched. It applies only to the
exact image and deployment controls below. Approval of the pull request by a
reviewer other than the risk owner is required before this record is effective;
the approval URL and release evidence must be retained before publishing.

## Identity and scope

- Exception ID: `SEC-2026-001`
- Findings: `CVE-2026-14456`; and the Go standard-library findings listed in
  the severity-specific
  [Critical](../../security/trivy/postgres-16-alpine-critical.yaml) and
  [High](../../security/trivy/postgres-16-alpine-high.yaml) exception files
- Affected component: `postgres:16-alpine` / PostgreSQL 16.15, OpenSSL
  3.5.7-r0, and gosu 1.19 built with Go 1.24.6
- Exact digest: `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`
- Affected release candidate: Community 1.0.1
- Severity source: Trivy 0.70.0 with the 2026-08-31 vulnerability database;
  one Critical and 23 High occurrences, all reported with fixed versions
- Date opened: 2026-08-31
- Expiry timestamp: 2026-09-30T23:59:59Z
- Remediation target: replace the pinned upstream digest as soon as an official
  PostgreSQL 16 image is rebuilt with corrected OpenSSL and gosu, and no later
  than the expiry date
- Risk owner: 徐鸿铎
- Independent approver: the protected-branch reviewer other than the risk
  owner; record the approval URL in the release evidence before publication

## Technical assessment

The Critical finding is in the Go TLS implementation embedded in the upstream
`/usr/local/bin/gosu` binary. The database service is explicitly launched as
UID/GID `70:70`, so the official entrypoint does not call gosu. The backup
service replaces the image entrypoint with the repository's local POSIX shell
loop and also does not call gosu. The reported network, TLS, URL, mail, XML,
template, and certificate-processing paths are not functionality exposed by
gosu in either shipped execution path.

`CVE-2026-14456` affects OpenSSL's QUIC server listener. PostgreSQL 16, the
backup client, and the shipped configuration do not create a QUIC listener.
PostgreSQL remains reachable only on the Compose network and the host loopback
binding by default. This reachability assessment reduces risk; it does not
change the affected package versions.

## Risk impact and exposure

- Vulnerable package paths: `/usr/local/bin/gosu`, plus the exact Alpine
  `libcrypto3` and `libssl3` package PURLs in the High exception file.
- Preconditions and reachable attack path: the gosu findings require an
  operator or attacker to reintroduce execution of that binary; the OpenSSL
  finding requires a QUIC server listener. Neither path exists in the shipped
  Compose execution. Changing the service user, entrypoint, TLS listener, or
  network boundary invalidates this assessment.
- Confidentiality, integrity, availability, safety, and cost impact: process
  compromise could expose or alter database records and encrypted application
  configuration, interrupt the API, or create recovery and resource-abuse
  cost. The platform is not a safety-control system, so no direct physical
  safety function is in scope; this does not reduce the data and service risk.
- Customer/operator exposure: PostgreSQL is reachable from the private Compose
  network and host loopback by default. Operators can override the bind address,
  so any wider exposure requires a new review before deployment.

## Temporary treatment

### Compensating controls

- PostgreSQL runs non-root with a read-only root filesystem, no Linux
  capabilities, `no-new-privileges`, and writable storage limited to its data
  volume and bounded tmpfs mounts.
- The root backup sidecar has a read-only root filesystem,
  `no-new-privileges`, and only `CAP_CHOWN`, which is required to publish
  snapshots to the backend reader group.
- The image is pinned by full multi-architecture RepoDigest. CI scans both all
  Critical and all fixable High findings against the dedicated,
  severity-specific exception files.
- The severity-specific exception files are scoped to these two scans,
  identify the gosu path or exact Alpine package PURLs, expire automatically,
  and are structurally checked by
  `scripts/check-container-security-exceptions.py`.

### Detection and alerting

- Docker health/restart state, PostgreSQL authentication and server logs, the
  backup sidecar health check, and the shipped backup-integrity/RPO Prometheus
  alerts are the minimum operational signals. Operators should forward these
  signals to their alerting system; the Community deployment does not ship a
  dedicated exploit detector or SIEM.
- CI performs fresh unfiltered scans and preserves the raw reports before any
  blocking gate. Any new Critical or fixable-High ID/component scope, a
  severity change that moves a finding into either gate, digest drift, control
  drift, or expiry fails the reviewed exception check. Unfixable High findings
  remain visible in the unfiltered report but are not represented as blocked by
  this exception gate.

### Rollback or containment

- On suspected compromise, block non-loopback database reachability, stop the
  dependent application and backup writers, preserve container/database logs
  and volumes, and rotate database, JWT, encryption, administrator, user, API,
  and upstream credentials as applicable.
- Rebuild from a reviewed replacement digest and restore a pre-incident,
  checksum-verified snapshot into an isolated database before reconnecting
  application traffic. Do not reuse the exception after changing its digest or
  deployment boundary.

### Verification evidence and test date

- 2026-08-31: PostgreSQL 16.15 initialized a clean volume and accepted an
  authenticated query while running as UID/GID `70:70`, with a read-only root
  filesystem, no capabilities, and `no-new-privileges`.
- 2026-08-31: the backup sidecar ran with only `CAP_CHOWN`, created a custom
  format dump of known test data, passed SHA-256 and `pg_restore --list`
  verification, and restored the exact data into an isolated database with
  `--single-transaction`.
- 2026-08-31: Trivy 0.70.0 reported the documented unfiltered counts against
  the exact digest; the two severity-specific files left zero unexcepted
  Critical/fixable-High results. This is verification of the gate, not proof
  that the upstream packages are fixed.

### Reassessment cadence

- Reassess on every vulnerability-database or image-digest change and at least
  weekly until closure. Any new Critical or fixable-High finding is not
  covered by this record; other newly reported findings remain subject to the
  release risk assessment and are not silently treated as remediated.
- The protected GitHub runner continuously gates the official `linux/amd64`
  release path. The paired PURL scopes were also checked on local
  `linux/arm64` on 2026-08-31, but that verification does not make the current
  amd64-only official release a multi-architecture release.
- CI uploads the unfiltered High/Critical JSON report even when a later
  blocking gate fails. Archive that report, its vulnerability-database
  timestamp, platform, exact digest, filtered result, and independent approval
  URL with the release evidence.

## Closure

- Fix commit and release: pending upstream rebuild
- Verification evidence: pending replacement-image scan and restore drill
- Closure date and approver: pending

An expired record, a changed image digest, a missing independent approval, or a
failure of any compensating control blocks release.

# Changelog

All notable changes are recorded here. The project follows Semantic Versioning.

## Unreleased

## [1.0.1] - 2026-08-31

### Security

- Required a high-entropy one-time administrator bootstrap token in production
  and limited wildcard CORS to bearer-authenticated gateway routes.
- Added in-console administrator password rotation with current-password
  verification, audit logging, and server-side revocation of every older admin
  session. Existing admin sessions from 1.0.0 must sign in again after upgrade.
- Made request admission fail closed when Redis rate-limit state is unavailable;
  disabled night-time and model-category rate-limit bypasses by default.
- Rejected malformed or non-object proxy JSON before routing and bounded,
  validated administrator-configured upstream headers to prevent framing and
  managed-header overrides.
- Added CodeQL, Bandit, dependency review, OpenSSF Scorecard, stricter dependency
  and container vulnerability gates, plus a versioned threat model and ASVS
  Level 2 evidence tracker.
- Hardened release provenance checks and offline packages with immutable image
  identities, exact source commits, checksums, and an explicit unsigned-source
  bundle boundary.
- Moved the backend build and runtime to a digest-pinned Alpine base, pinned
  the backup client to the PostgreSQL 16 server major, and removed the Perl
  packages responsible for unresolved Critical findings in the former Debian
  image.
- Refreshed the digest-pinned unprivileged Nginx runtime to include the Alpine
  OpenSSL 3.5.8 fix for CVE-2026-14456.
- Upgraded the pinned Prometheus runtime to 3.14.0 after validating the existing
  scrape configuration and alert rules, and added fixable-High image gates for
  the clean Prometheus and Redis runtime images. Redis now starts directly as
  its non-root account with a read-only root filesystem and no capabilities;
  the optional replica and Sentinel processes inherit the same boundary. The
  replica now keeps its own AOF-backed volume, and CI proves a promoted node's
  acknowledged write survives an abrupt process exit and restart. Each
  Sentinel also persists its elected-master state and epoch in an isolated
  protected volume. Redis startup now requires three consecutive 2-of-3
  agreements on host, port, and configuration epoch instead of falling back to
  a fixed original master, while a quorum gate blocks backend cold-start until
  the selected master is reachable. CI recreates every container and the
  network without deleting volumes, then proves the acknowledged write and
  promoted role survive; it also proves recovery with one Sentinel state
  volume missing. Sentinel management authentication is mandatory.
- Hardened PostgreSQL to start directly as its non-root account with an
  immutable root filesystem and no capabilities; constrained the backup
  sidecar to its single required capability. Added exact-digest, expiring
  Trivy exception enforcement that requires independent review for narrowly
  assessed findings in the upstream PostgreSQL runtime.
- Added a severity-isolated Grafana High gate and exact component-scoped,
  expiring exception record for the current upstream bundled datasource
  findings; the Grafana Critical gate remains unfiltered.
- Added always-uploaded, unfiltered PostgreSQL and Grafana High/Critical JSON
  evidence and Trivy database metadata alongside the severity-specific
  blocking scans. CI now compares those raw reports bidirectionally with every
  reviewed path/PURL and rejects stale databases or scanner/scope drift. The
  complete container-security job, evidence-step adjacency and artifact inputs
  are review-locked to reject inherited scanner overrides or evidence rewrites;
  implicit root Trivy config and ignore files are forbidden.
- Corrected the Nginx CI syntax smoke test to resolve the Compose-only backend
  name without weakening the production upstream configuration.

### Operations

- Documented the runtime security baseline, release-blocking criteria, incident
  response process, and safe deployment settings for source and offline installs.
- Disabled Gunicorn's unused filesystem control socket so the backend starts
  cleanly under its read-only container filesystem.

### Reliability

- Synchronized ORM metadata with the existing database constraints and query
  indexes, and added an Alembic schema-drift gate after every clean migration.

## [1.0.0] - 2026-08-25

### Added

- Added a fail-closed, versioned application-extension API with deterministic
  lifecycle handling, stable authentication/database dependencies, and a
  first-writer-wins provider registry.
- Documented and machine-declared the public Community versus private
  Enterprise source, license, dependency, and release boundaries.

### Security

- Removed the organization-specific external identity integration and its
  incomplete replacement bridge.
- Hardened local account bootstrap, password policy, session invalidation and
  browser security headers.
- Sanitized operator exports and neutralized spreadsheet formulas.
- Updated vulnerable Python and JavaScript dependencies.
- Disabled dynamic FastAPI documentation in production and published a
  reviewed gateway-only OpenAPI specification.
- Pinned CI actions and service images; added signed, SBOM-attested GHCR
  release artifacts.

### Reliability

- Corrected bounded usage-retention deletion.
- Made usage failover recovery persistent and idempotent across workers.
- Serialized migrations and first-run seed operations.
- Added explicit database and upstream connection budgets.
- Split the four F-complexity route handlers into focused query, validation,
  serialization, and response helpers.
- Added a production-like Playwright flow covering first-admin claim, branding,
  key lifecycle, streaming relay, logout, and documentation policy.

### Operations

- Added security, contribution and release policies.
- Expanded CI dependency, migration, release-hygiene and container checks.
- Added a repository-level version source, release-tag validation, Dependabot,
  Issue forms, pull-request templates, CODEOWNERS, maintainers, and support
  boundaries.

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

### Operations

- Documented the runtime security baseline, release-blocking criteria, incident
  response process, and safe deployment settings for source and offline installs.
- Disabled Gunicorn's unused filesystem control socket so the backend starts
  cleanly under its read-only container filesystem.

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

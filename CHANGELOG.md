# Changelog

All notable changes are recorded here. The project follows Semantic Versioning.

## Unreleased

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

# Changelog

All notable changes are recorded here. The project follows Semantic Versioning.

## Unreleased

### Security

- Removed the organization-specific external identity integration and its
  incomplete replacement bridge.
- Hardened local account bootstrap, password policy, session invalidation and
  browser security headers.
- Sanitized operator exports and neutralized spreadsheet formulas.
- Updated vulnerable Python and JavaScript dependencies.

### Reliability

- Corrected bounded usage-retention deletion.
- Made usage failover recovery persistent and idempotent across workers.
- Serialized migrations and first-run seed operations.
- Added explicit database and upstream connection budgets.

### Operations

- Added security, contribution and release policies.
- Expanded CI dependency, migration, release-hygiene and container checks.

The final release date and version will be assigned only after the public
license and clean-history release repository have been approved.

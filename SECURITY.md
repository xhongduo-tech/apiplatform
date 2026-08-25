# Security Policy

## Supported releases

Security fixes are provided for the latest tagged minor release. Pre-release
commits and locally modified deployments are supported on a best-effort basis.
The project does not currently promise an LTS support window.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, private
data, or a working proof of concept. Use the repository host's private security
advisory feature, or contact the maintainers through the private address listed
in the repository metadata.

Please include the affected version, deployment topology, reproduction steps,
impact, and any suggested mitigation. Maintainers should acknowledge a report
within five business days and coordinate disclosure after a fix is available.

## Deployment baseline

- Keep the console bound to loopback until administrator bootstrap is complete.
- Generate independent database, Redis, JWT, bootstrap and data-encryption
  secrets for every deployment.
- Terminate TLS at a trusted reverse proxy and keep PostgreSQL, Redis,
  Prometheus and Grafana off public interfaces.
- Keep public registration and password recovery disabled unless a verified
  invitation/recovery mechanism has been configured.
- Run `scripts/check-public-release.sh`, dependency audits and a restore drill
  before publishing a release.

Never attach database dumps, `.env` files, API keys, response logs, or private
Git history to a vulnerability report.

## Secret and encryption-key rotation

Production deployments must use independent values for `JWT_SECRET` and
`DATA_ENCRYPTION_KEY`. To rotate database encryption, stop request-serving
workers (or enter a maintenance window), keep PostgreSQL available, and run in
the backend image:

```bash
DATA_ENCRYPTION_KEY='<current>' NEW_DATA_ENCRYPTION_KEY='<new-base64-key>' \
  python -m app.rotate_encryption_key
```

The command prints non-secret SHA-256 key fingerprints. Record the old and new
fingerprints in the operator's backup inventory (never record the keys in Git
or logs), and label each off-site backup with the fingerprint of the key that
was active when it was created. Only replace the deployment's
`DATA_ENCRYPTION_KEY` after the command commits. Retain every previous key in
the deployment secret manager for at least the full retention period of every
backup encrypted with it, and complete a restore drill using the matching key
before retirement. A successful drill of only the newest backup is not enough
to retire keys needed by older retained backups.

After migration revision `035_encrypt_secrets`, runtime ORM reads fail closed
when a protected column is not a supported authenticated envelope. Legacy
plaintext is accepted only inside the transactional migration. The current v1
envelope authenticates the field context but not a row primary key, so direct
database write access remains a trusted administrative boundary; restrict it
accordingly and include row-bound AAD in any future envelope-format upgrade.

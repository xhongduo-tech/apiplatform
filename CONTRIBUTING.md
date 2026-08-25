# Contributing

Thank you for helping improve Open API Platform.

## Development workflow

1. Create a focused branch and keep unrelated changes out of the pull request.
2. Add tests for behavior changes, including failure and authorization paths.
3. Run the backend and frontend checks documented below.
4. Describe migrations, configuration changes and rollback considerations in
   the pull request.
5. Never commit real users, credentials, request/response content, database
   exports, infrastructure addresses or organization-specific branding.

Backend checks:

```bash
cd backend
python -m ruff check app tests ../scripts
python -m pytest
python -m alembic upgrade head
```

Frontend checks:

```bash
cd frontend
npm ci
npm run check:i18n
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Before a public release:

```bash
bash scripts/check-public-release.sh
```

Security issues must follow [SECURITY.md](SECURITY.md), not the public issue
tracker. Contributions are expected to include documentation for new settings
and migrations. Breaking API changes require a deprecation note and changelog
entry.

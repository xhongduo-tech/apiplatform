## Summary

<!-- What changes, and why? Link the issue when one exists. -->

## Validation

- [ ] Backend lint and tests pass.
- [ ] Frontend i18n, typecheck, tests, and build pass.
- [ ] Full-stack E2E passes when a user-facing flow or gateway behavior changed.
- [ ] New settings, migrations, and API behavior are documented.

## Security and privacy

- [ ] No real users, credentials, request/response content, database exports,
      internal addresses, or organization-specific branding are included.
- [ ] Authorization, error, and rollback paths were considered.
- [ ] Dependency and container changes use pinned, reviewable versions.
- [ ] A new endpoint, identity, secret, data store, extension hook, deployment
      mode, privileged job, or artifact channel updates the threat model and
      ASVS evidence in the same pull request.
- [ ] Authentication, authorization, cryptography, bootstrap, migration,
      backup/restore, and release-pipeline changes received an independent
      security review, or the missing reviewer is recorded as a release blocker.
- [ ] Any accepted finding links a complete, approved, unexpired security
      exception based on `docs/SECURITY_EXCEPTION_TEMPLATE.md`.

## Compatibility and operations

- [ ] Breaking changes include deprecation and changelog notes.
- [ ] Database migrations are reversible or have a documented recovery plan.
- [ ] Configuration defaults are safe for production.

## Screenshots

<!-- Add screenshots for visible UI changes; remove this section otherwise. -->

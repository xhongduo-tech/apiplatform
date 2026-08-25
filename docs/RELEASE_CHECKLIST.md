# Public release checklist

The source tree is not ready to publish merely because private files were
deleted from the current checkout. Complete every item below for each release.

## Legal and repository boundary

- [ ] The copyright owner has selected and approved a project license.
- [ ] `LICENSE` is present and compatible with bundled fonts/assets and runtime
      dependencies.
- [ ] The release is created from a new clean repository, or a verified history
      rewrite; old database dumps and internal assets are absent from every Git
      object, tag and release artifact.
- [ ] Third-party notices/SBOM have been generated and archived.

## Security and privacy

- [ ] `scripts/check-public-release.sh` passes from a clean checkout.
- [ ] Python, npm, container and secret scans pass or have documented,
      time-bounded exceptions.
- [ ] Public registration/recovery and demo data match the intended deployment
      profile.
- [ ] Administrator bootstrap is complete before the bind address is widened.
- [ ] No API key, password hash, response preview or private topology appears in
      source, exports, images, logs or documentation.

## Upgrade and recovery

- [ ] Empty-database and supported-version Alembic upgrades pass.
- [ ] Backup checksum, retention, encryption/storage policy and off-host copy
      are configured.
- [ ] A restore into an isolated database was completed and validated.
- [ ] RPO, RTO, rollback and configuration changes are documented.

## Quality

- [ ] Backend, frontend, integration and end-to-end tests pass.
- [ ] Mobile navigation, keyboard operation and contrast are checked.
- [ ] Images are built reproducibly, scanned, accompanied by an SBOM and signed.
- [ ] `CHANGELOG.md`, support window and upgrade notes are complete.
- [ ] Before creating the release tag, a repository administrator has confirmed
      that immutable releases are enabled in repository settings, or with
      `gh api repos/xhongduo-tech/apiplatform/immutable-releases --jq '.enabled'` returning
      `true`. This administrator-only check cannot be delegated to `GITHUB_TOKEN`.
- [ ] Both GHCR packages are linked to this repository and have `public`
      visibility, so the documented Docker deployment works anonymously.

GitHub Container Registry packages created under a personal account are private
by default even when they are linked to a public repository. On the first
release, the image publication job therefore stops before signing and before it
creates a GitHub Release. Open each new package's settings, confirm the source
repository link, change its visibility to **Public**, and rerun the failed job.
This visibility change cannot be reversed. Later releases reuse the already
public packages and pass the gate automatically.

The release workflow creates or resumes a draft, uploads and verifies every
asset's name, size and SHA-256 digest, then publishes it. It fails closed unless
GitHub reports the published release as immutable. Enabling immutability later
does not retrofit an existing release: delete a non-immutable failed release,
enable the repository setting, and rerun the release workflow.

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
- [ ] CodeQL (Python and JavaScript/TypeScript), Bandit, Python, npm, container,
      Scorecard and secret scans pass or have documented,
      time-bounded exceptions. The release workflow also reports no open High
      or Critical CodeQL alert; a successful analysis job alone is insufficient.
- [ ] Every exception uses the
      [security exception template](SECURITY_EXCEPTION_TEMPLATE.md), has the
      required owner and independent approval, and is unexpired on the release
      date. Missing approval or expiry blocks the release.
- [ ] Every Trivy ignore is limited to the exact reviewed component/path,
      links to its human exception record, passes
      `scripts/check-container-security-exceptions.py`, and has its independent
      approval URL preserved in the release evidence. A suppressed scan alone
      is not approval.
- [ ] Download and archive the CI
      `third-party-container-vulnerability-evidence` artifact. Record its
      scanner/database timestamp, platform, exact image digest, unfiltered and
      unexcepted counts, exception expiry, and independent approval URL.
- [ ] If the `container-security` job body changed, review the complete job and
      record why each command, Action input or ordering change is safe before
      updating `CONTAINER_SECURITY_JOB_SHA256`; never refresh that digest as an
      unexplained mechanical change.
- [ ] Confirm no root-level `.trivyignore`, `trivy.yaml`, or equivalent implicit
      Trivy file exists; all accepted findings must use the explicit,
      severity-specific reviewed exception paths.
- [ ] The threat model and ASVS tracker cover every new endpoint, trust
      boundary, secret, data store, deployment mode and privileged workflow.
- [ ] Public registration/recovery and demo data match the intended deployment
      profile.
- [ ] Administrator bootstrap is complete before the bind address is widened.
- [ ] Administrator password rotation was tested: the current password is
      required, older admin sessions are rejected, and the replacement session
      remains usable without recording password material in the audit log.
- [ ] No API key, password hash, response preview or private topology appears in
      source, exports, images, logs or documentation.

## Upgrade and recovery

- [ ] Empty-database and supported-version Alembic upgrades pass.
- [ ] Backup checksum, retention, encryption/storage policy and off-host copy
      are configured.
- [ ] A restore into an isolated database was completed and validated.
- [ ] When the Sentinel overlay is supported, its failover drill passes the
      full container/network recreation and one-state-volume-loss cases. The
      two Redis data volumes and three Sentinel state volumes are retained as
      one recovery set; all three Sentinel volumes are never reinitialized
      while Redis data is retained.
- [ ] RPO, RTO, rollback and configuration changes are documented.

## Quality

- [ ] Backend, frontend, integration and end-to-end tests pass.
- [ ] Every exact direct pin in `backend/requirements.txt` (including names with
      extras) matches the corresponding normalized package/version in the
      hash-locked `backend/requirements.lock`; run
      `python scripts/check-requirements-lock.py` after regenerating the lock.
- [ ] Mobile navigation, keyboard operation and contrast are checked.
- [ ] Images are built by the protected workflow, scanned, accompanied by an
      SBOM and verifiable build provenance, signed, and consumed by digest.
      The release job must verify that each provenance statement binds the
      exact image name and RepoDigest, repository, tag, full commit, checked-in
      release workflow and GitHub-hosted runner before Cosign signing. Build
      provenance identifies the builder and inputs; it does not by itself
      prove reproducibility or absence of defects.
- [ ] `CHANGELOG.md`, support window and upgrade notes are complete.
- [ ] Create `v<version>` as an annotated, signed tag whose tagger identity is
      exactly `徐鸿铎 <x.hongduo@hotmail.com>`, and push the tag only after its
      signing public key is registered with GitHub. The tag object must point
      directly to the release commit (not another tag). GitHub REST must report
      `verification.verified=true` and `verification.reason=valid`; lightweight,
      unsigned, indirectly targeted or differently attributed tags fail closed.
- [ ] Before creating the release tag, a repository administrator has confirmed
      that immutable releases are enabled in repository settings, or with
      `gh api repos/xhongduo-tech/apiplatform/immutable-releases --jq '.enabled'` returning
      `true`. This administrator-only check cannot be delegated to `GITHUB_TOKEN`.
- [ ] Both GHCR packages are linked to this repository and have `public`
      visibility, so the documented Docker deployment works anonymously.
- [ ] Do not attach or advertise a locally generated `offline-images/`
      directory as an official release. `build-offline.sh` deliberately marks
      its inner manifests `UNSIGNED_USER_BUILD`; hashes detect drift but do not
      authenticate a publisher. An official offline artifact remains blocked
      until the release workflow consumes the just-published project image
      RepoDigests and signs an outer manifest binding the archive digest, full
      commit and all six image source digests.

GitHub Container Registry packages created under a personal account are private
by default even when they are linked to a public repository. On the first
release, the image job always pushes unique commit/run/attempt staging tags,
binds Docker's acknowledged digests, and creates/verifies provenance, signatures,
and an exact reproducible SBOM attestation. Canonical state is read with an
authenticated OCI manifest `HEAD`, checked against `Docker-Content-Digest`, and
independently resolved with `docker buildx imagetools inspect`; the personal-owner
Packages REST endpoint is used only for the final public/link visibility gate.
Its 404 response never proves that a private package or canonical tag is absent.
After exact canonical promotion, open each new package's settings, confirm the
source repository link, change its visibility to **Public**, and rerun the failed
job. This visibility change cannot be reversed.

Every rerun uses a new staging tag. If a canonical version tag is already visible
when checked, a different digest is rejected; the expected digest is reusable only
after its release labels, exact commit-bound GitHub provenance, Cosign signature,
and exact SPDX predicate pass. Existing valid referrers are reused rather than
duplicated so the evidence bundle remains stable across resumable attempts. The
signed annotated tag and exact default-branch HEAD are checked immediately before
and after promotion.

GHCR does not provide this workflow an atomic create-if-absent operation for a
tag. Repository `concurrency` serializes these release runs, but cannot serialize
an owner's PAT, GitHub App, another repository, or a manual package writer. Before
tagging, the package administrator must verify that this release workflow is the
only principal with package write access for both image packages and keep other
writers disabled throughout promotion. In the narrow interval between the
authenticated absence check and manifest creation, an independent writer could
create a tag that this workflow then replaces; the post-check proves only the
final expected digest. Therefore the signed `image-digests-<version>.txt` and
RepoDigests are the authenticity/deployment boundary, while the version tag is a
discovery convenience. Production examples consume RepoDigests only.

If either image promotes alone, rerun only after verifying that its canonical tag
still equals the signed expected digest; the workflow can reuse that side and
finish the other. If package write access, an unexpected digest, or concurrent
activity is in doubt, stop the release, revoke/rotate the unexpected writer,
retain logs/evidence, and perform a manual incident review rather than retagging.

When a direct production dependency changes, regenerate the hash lock with a
reviewed `pip-tools` environment, then run the sync gate and a hash-enforced
installation before committing both files:

```bash
cd backend
python -m piptools compile --generate-hashes --resolver=backtracking \
  --output-file requirements.lock requirements.txt
cd ..
python scripts/check-requirements-lock.py
python scripts/test-requirements-lock-sync.py
python -m pip install --require-hashes --requirement backend/requirements.lock
```

The image job captures post-promotion GitHub provenance output, raw and verified
Cosign signature evidence, each normalized SPDX SBOM, the verified SBOM
attestation envelopes, and a manifest that hashes and binds every copy to the
exact image RepoDigest. It then keyless-signs the checksum manifest and stores a
Sigstore bundle. `verify-release-evidence.py` validates structural/digest binding;
it is not a cryptographic trust root by itself. A verifier must first authenticate
`SHA256SUMS-<version>.txt` with its `.sigstore.json` bundle and a trusted Cosign /
Sigstore root. A separate final job alone receives `contents: write`;
it downloads the exact current-run artifact ID, checks its GitHub artifact digest,
offline evidence manifest, the hard-coded 15-asset whitelist, checksum coverage,
canonical tags, and live OCI referrers. The producer also enforces the hard-coded
13-file pre-checksum payload whitelist and the final 15-file whitelist, preventing
an earlier action from smuggling an additional safe-named file into the signed
artifact. In its clean checkout, the final job decompresses the candidate source
archive and byte-compares it with `git archive --format=tar` of the exact `HEAD`
and release prefix; this binds source independently of the lower-privileged image
job. Release title, one-line body, tag, and `github-actions[bot]` author are
deterministic. On a rerun, the job downloads **all** allowlisted assets of an existing
draft or immutable published Release into a new private temporary directory,
using one exact download pattern for each expected filename. It first requires
the exact safe filename whitelist, then verifies the candidate's
own keyless checksum signature with the fixed workflow identity, GitHub issuer,
and current release commit SHA, followed by exact checksum coverage and values,
evidence structure, image digest file, signed tag,
default-branch HEAD, canonical tags, and live OCI referrers. This intentionally
does not compare a resumed draft's Sigstore bundle byte-for-byte with the current
attempt: keyless signatures can differ, while either bundle must independently
authenticate the same release boundary.

Only a completely empty draft may receive the current attempt's assets, and the
upload never enables overwrite/clobber behavior. A non-empty draft is published
unchanged only when every verification passes; otherwise the workflow fails and
requires a maintainer to delete the draft and rerun. An already published Release
must pass the same downloaded-asset verification and already be immutable before
a rerun succeeds. After publishing a draft, the job downloads and authenticates
all assets again and fails closed unless GitHub reports the Release immutable.
Enabling immutability later does not retrofit an existing Release: delete a
non-immutable failed Release, enable the repository setting, and rerun the
workflow.

For each project image, independently verify the GitHub build provenance and
the separate Cosign signature. Replace the placeholders with the exact values
from `image-digests-<version>.txt` and the signed tag object:

```bash
gh attestation verify "oci://<image@sha256:digest>" \
  --bundle-from-oci \
  --repo xhongduo-tech/apiplatform \
  --signer-workflow xhongduo-tech/apiplatform/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> \
  --source-digest <40-character-release-commit> \
  --deny-self-hosted-runners

cosign verify \
  --certificate-identity \
  'https://github.com/xhongduo-tech/apiplatform/.github/workflows/release.yml@refs/tags/v<version>' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  '<image@sha256:digest>'
```

Before trusting any downloaded Release asset, authenticate the checksum manifest
and then verify every listed file:

```bash
cosign verify-blob 'SHA256SUMS-<version>.txt' \
  --bundle 'SHA256SUMS-<version>.sigstore.json' \
  --certificate-identity \
    'https://github.com/xhongduo-tech/apiplatform/.github/workflows/release.yml@refs/tags/v<version>' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-sha <40-character-release-commit>
sha256sum --check --strict 'SHA256SUMS-<version>.txt'
```

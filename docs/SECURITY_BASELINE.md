# Product security baseline

This document defines the minimum security controls for Community development,
release, and operation. It is a control baseline and evidence index, not a
claim of certification or complete compliance with any external standard.

## Reference standards

- [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) organizes the
  lifecycle around preparing the organization, protecting software, producing
  well-secured software, and responding to vulnerabilities.
- [OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/)
  is the application-control catalogue. This project uses Level 2 as its
  verification target because it processes credentials and administrative data.
- [SLSA 1.2](https://slsa.dev/spec/v1.2/) guides source and build integrity.
  A SLSA level is claimed only for a particular artifact after its provenance
  has been independently verified.
- [OpenSSF Scorecard](https://openssf.org/scorecard/) supplies a continuously
  updated repository-health signal. A score is not a substitute for review.

The chapter-level ASVS coverage record is maintained in
[ASVS 5.0 Level 2 tracking](ASVS-5.0-L2.md); attack assumptions and trust
boundaries are maintained in [the threat model](THREAT_MODEL.md).

## Required controls and evidence

| Control | Automated evidence | Human evidence |
| --- | --- | --- |
| Security requirements and design review | Versioned baseline and threat-model presence is checked by `scripts/check-public-release.sh` | Pull request security/compatibility checklist |
| Protected source | Required CI, signed commits/tags, immutable release/tag rules, pinned Actions | Maintainer and release-owner review |
| Secret prevention | Full-history Gitleaks scan, GitHub push protection, release hygiene scan | Incident rotation record if a secret is exposed |
| Application security | CodeQL for Python and JavaScript/TypeScript, a release gate for open High/Critical CodeQL alerts, Bandit, Ruff, unit/integration/E2E tests; first-admin claim and admin password-rotation/session-revocation tests | Review of authorization, cryptography, migrations, and trust-boundary changes |
| Dependency security | `pip-audit`, `npm audit`, Dependabot, pinned container and Action references | Time-bounded exception with owner and compensating control |
| Container security | Trivy gate and SPDX SBOM for project images | Review of unresolved upstream findings and deployment exposure |
| Release integrity | Signed annotated tag, Cosign-signed checksum manifest, immutable GitHub Release, digest-addressed images, image signatures, SBOM attestations and build provenance | Independent verification of release identity, the checksum Sigstore bundle and evidence; confirmation that the release workflow is the sole GHCR package writer during non-atomic tag promotion |
| Secure operation | Production preflight, non-root/read-only containers, loopback defaults, TLS guidance, backup checks | Secret inventory, least-privilege review, restore drill and key-version record |
| Vulnerability response | Private Vulnerability Reporting and supported-version policy | Triage, coordinated disclosure, advisory, remediation and retrospective |

No release may call a control “implemented” unless the linked automated check
passes or the release evidence contains a named, expiring exception. An
exception records the affected component/CVE, exploitability, owner, approval,
compensating controls, target remediation release, and expiry date. “No vendor
fix” by itself is not an exception. Every exception must use the
[security exception template](SECURITY_EXCEPTION_TEMPLATE.md), be approved by
the required independent reviewer, and remain unexpired on the release date;
an expired or incompletely approved record cannot satisfy a gate.

Scanner suppressions are controls, not comments. A suppression must be scoped
to one exact component or path, link to a reviewed exception record, carry an
enforced expiry, and preserve an unsuppressed scan of all other findings. CI
must fail when the record, exact image digest, compensating deployment control,
or expiry drifts. Protected-branch approval is part of the exception evidence;
a green scanner result by itself does not approve the risk.
The container job preserves unfiltered High/Critical JSON reports for every
excepted third-party image even when a blocking scan fails. Release evidence
must bind the report, scanner/database timestamp, target platform, exact image
digest, pre/post-exception counts, exception record, and approval URL.
Before blocking scans run, CI also compares every fixable-High and all-Critical
report scope in both directions with the reviewed path/PURL sets. A new
Critical or fixable-High finding, stale exception, architecture mismatch,
malformed report, scanner-version drift, or vulnerability database older than
72 hours fails closed. Unfixable High findings remain in the unfiltered evidence
for release risk assessment; this gate does not represent them as remediated.
Every Trivy invocation pins the reviewed scanner version and uses one
runner-temporary cache outside the checked-out repository. The metadata step
reads that exact cache and validates the database schema, build time, download
time and update window, so repository files cannot substitute scanner state.
The checker also locks the complete `container-security` job body. Treat a job
digest change as a security review event: review every step, command, action
input and ordering change before updating the lock. The protected workflow,
independent reviewer, pinned Actions, hosted runner and GitHub artifact service
remain trust roots; the pull-request evidence artifact is not represented as an
independently signed release attestation.
Root-level `.trivyignore`, `trivy.yaml` and equivalent implicit files are
forbidden because Trivy would auto-load them before producing evidence. Every
permitted exception is instead named explicitly by one locked scan step and
validated against its human risk record.

## Security gates

Every pull request to `main` must pass the release hygiene, dependency,
backend, frontend, browser E2E, container, and CodeQL checks relevant to the
change. The scheduled Scorecard run detects repository-control regressions.
Release tags additionally require the immutable release workflow and artifact
verification described in [the release checklist](RELEASE_CHECKLIST.md).

The following conditions block a release:

- an exploitable Critical or High application finding without an approved,
  unexpired exception;
- an unreviewed authentication, authorization, cryptography, bootstrap, data
  migration, backup, or release-pipeline change;
- a missing or invalid signature, provenance statement, SBOM, checksum, or
  image digest;
- a known secret or private data item in the tree, history, image, artifact, or
  diagnostic bundle;
- a failed clean-database migration, production preflight, release-critical
  browser flow, or isolated restore drill;
- an open High or Critical CodeQL alert on the release branch.
- an unreviewed GHCR package writer or concurrent package-write activity during
  the canonical tag promotion window.

## Change and review rules

Update the threat model in the same pull request when a new public endpoint,
identity provider, extension capability, secret, data store, trust boundary,
deployment mode, or privileged job is introduced. Update the ASVS tracker when
a control or verification method changes. Review this baseline before every
minor release and after every confirmed security incident.

Commercial contracts may promise narrower response times or longer support
windows, but they cannot weaken these technical release gates. Proprietary
licensing controls entitlement authenticity; they do not replace application,
supply-chain, operational, or incident-response security.

## Project container boundaries

The backend uses a digest-pinned, multi-stage Alpine image. The runtime keeps
only the application dependencies and the PostgreSQL 16 client required by the
documented backup feature; its major version matches the database and restore
runtime. Python package installers and Perl are absent. It
runs as UID/GID `10001` and is compatible with the read-only container policy.
The CI gate scans every Critical finding, including findings without an
upstream fix, and separately blocks fixable High findings. Changing the base
distribution, package set, runtime user, or backup client therefore requires a
container smoke test, both vulnerability gates, and an updated SBOM.

The web image uses a digest-pinned unprivileged Nginx runtime and runs as UID
`101`; the Node build stage is not copied into the runtime. Base-image digest
updates remain release-gated by both web-image vulnerability scans and a new
SPDX SBOM.

Third-party Compose images are also digest-pinned. Redis and Prometheus have
blocking all-Critical and fixable-High gates. Redis additionally starts directly
as its non-root image account with a read-only root filesystem, no capabilities,
and `no-new-privileges`. PostgreSQL has the same two gates;
the dedicated, exact-digest exceptions in
[SEC-2026-001](security-exceptions/SEC-2026-001-postgres-runtime.md) expire
automatically and are valid only with the documented non-root/read-only
database boundary and independently approved release evidence. Grafana keeps
an unfiltered all-Critical gate and a separate fixable-High gate whose exact
component exceptions are recorded in
[SEC-2026-002](security-exceptions/SEC-2026-002-grafana-runtime.md). The default
restricted Grafana boundary is a compensating control, not a remediation or a
claim that affected bundled plugins are unreachable.

# Threat model

## Scope and assumptions

This model covers the Community gateway, administrator and user consoles,
PostgreSQL, Redis, backup tooling, upstream model connections, and the public
build/release pipeline. It assumes the signed application images, host kernel,
container control plane, deployment secrets, trusted reverse proxy, and system
clock are administered by the operator.

A hostile host root, database owner, or release-owner account can replace code
or secrets and is outside the application's containment boundary. The controls
below reduce mistakes and remote compromise; they do not claim resistance to a
fully privileged operator. Enterprise licensing has the same limit unless it
adds an external activation or hardware trust service.

## Assets and trust boundaries

| Asset or boundary | Security property |
| --- | --- |
| Administrator identity and bootstrap token | Only the intended operator can claim and control an instance |
| User credentials, browser sessions and API keys | Confidentiality, revocation, least privilege and CSRF resistance |
| Upstream provider credentials | Authenticated encryption at rest; never returned or logged in plaintext |
| Request metadata and usage records | Tenant/user authorization, integrity, retention and content minimization |
| PostgreSQL, Redis and backup repository | Private network exposure, authenticated access, recoverability and key separation |
| Gateway-to-upstream traffic | Approved destinations, TLS, bounded cost and failure isolation |
| Extension boundary | Explicit provider registration without arbitrary module loading |
| Source, CI identity and release artifacts | Reviewed source, reproducible identity, provenance, signatures, SBOM and immutable digest |

The public network terminates at Nginx. Nginx forwards gateway and console
traffic to FastAPI. FastAPI crosses separate trust boundaries to PostgreSQL,
Redis, configured upstream providers and optional extensions. Administrators
cross a higher-privilege boundary than API-key holders. Backup storage and its
encryption material are separate recovery domains.

## Principal threats and required treatment

| ID | Threat | Required treatment | Residual boundary |
| --- | --- | --- | --- |
| T1 | An attacker claims a new installation first | Production requires an unpredictable bootstrap token; loopback bootstrap; atomic first-admin credential creation | An operator who exposes an uninitialized development instance accepts this risk; after claim the retained production variable has no authentication effect but remains a secret-management responsibility |
| T2 | Password, cookie, JWT or API-key theft | Strong password hashing, HttpOnly/SameSite cookies, origin checks, server-side user/admin token versioning, current-password-protected rotation, key hashing, short administrative sessions and step-up for destructive actions | Endpoint compromise can still steal active credentials; the shared Community admin cannot identify the natural person behind an action |
| T3 | Cross-site admin action or injected UI content | Same-origin administration, scoped CORS, CSRF request metadata checks, React text rendering and CSP/security headers | CSP still permits required inline styles and remains a hardening target |
| T4 | Broken object authorization or privilege escalation | Central dependencies, role and ownership checks, negative authorization tests, CodeQL and review | New routes require explicit threat/ASVS review |
| T5 | Injection, unsafe parsing or filesystem escape | Parameterized inputs, fixed allowlists, size/path checks, static analysis and malformed-input tests | Administrator-configured upstream URLs remain a trusted configuration boundary |
| T6 | Request aliases, oversized outputs or unlimited traffic create denial of service or upstream cost | Positive production RPM/TPM defaults; prompt plus bounded-output reservation across Chat/Completions/Responses/Anthropic aliases and multi-candidate fields; oversized single requests rejected even on an empty bucket; enforcement fails closed | Explicit per-key unlimited grants and capacity/upstream concurrency remain operator risk decisions |
| T7 | Redis/PostgreSQL/upstream failure corrupts state or hangs request workers | Readiness checks, Redis connect/socket and whole-admission timeouts, Sentinel master discovery wired into the backend, transactional writes, bounded fallback, original-bucket atomic token correction, idempotent usage persistence and restore tests | A complete dependency outage intentionally rejects new inference requests; post-response corrections remain best-effort; an accepted write whose response is lost can conservatively occupy quota until the approximately 70-second bucket expiry |
| T8 | Secrets or private data leak through source, logs or support | History/secret scanning, encrypted fields, masked values, minimized logs, fictional fixtures and support redaction rules | Operators control external log and backup destinations |
| T9 | Dependency, CI, tag or artifact compromise | Digest/SHA pinning, protected source, CodeQL/Scorecard, vulnerability scans, signed tags/images, SBOM, provenance, immutable releases, and a sole package-writer promotion procedure | GHCR tag creation is not atomic create-if-absent; an external package writer can race the promotion window. Production trust is the signed RepoDigest, not the version tag. Compromise of source/signing identity requires emergency rotation and release withdrawal |
| T10 | Backups are missing, unreadable or paired with the wrong key | Checksummed backups, off-host retention, key fingerprints and isolated restore drills | Community logical backups do not provide enterprise PITR/WORM guarantees |
| T11 | Malicious or incompatible extension executes in-process | Explicit configured extension list, compatibility contract and provider registry | Installed extensions execute inside the backend trust boundary and require equivalent review |

## Security invariants

- Production must not start with missing mandatory secrets or an unprotected
  administrator-claim path.
- Explicit malformed boolean/numeric security settings, disabled global rate
  limits, and invalid enabled night-window timezone/time values must stop
  production startup rather than silently select a weaker default.
- Authentication, authorization, rate/cost enforcement and license checks fail
  closed when their decision cannot be made safely.
- Recovery and safe data export remain available during entitlement or service
  incidents whenever doing so does not expose secrets.
- Plaintext provider credentials, user passwords, session tokens, API keys and
  bootstrap tokens never enter audit events, release artifacts or support logs.
- Published artifacts are consumed by digest and verified against an expected
  repository/workflow identity; a checksum delivered beside an artifact is not
  by itself proof of publisher identity.

## Review triggers

Review this model for every new public route, authentication method, externally
reachable service, browser origin, file parser, secret type, data store,
extension hook, backup backend, CI permission, or artifact channel. A confirmed
incident must update this document when it reveals a missing threat or invalid
assumption.

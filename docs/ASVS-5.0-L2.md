# OWASP ASVS 5.0 Level 2 tracking

Level 2 is the target for the network-accessible application. This is a
chapter-level planning and evidence index, not an ASVS assessment report.
“Partial” means that controls exist but every applicable Level 2 requirement
has not yet been independently traced and verified.

| ASVS 5.0 chapter | Applicability | Current evidence | Status |
| --- | --- | --- | --- |
| V1 Encoding and Sanitization | Applicable | React text rendering, output/header tests, input helpers | Partial |
| V2 Validation and Business Logic | Applicable | Pydantic schemas, allowlists, quota and state-transition tests | Partial |
| V3 Web Frontend Security | Applicable | CSP and security headers, CSRF metadata checks, browser E2E | Partial |
| V4 API and Web Service | Applicable | Versioned gateway OpenAPI, request limits, auth dependencies | Partial |
| V5 File Handling | Applicable | Backup path/format/size validation and isolated restore scripts | Partial |
| V6 Authentication | Applicable | First-admin claim, PBKDF2 password storage, rate-limit tests, current-password-protected admin rotation | Partial |
| V7 Session Management | Applicable | HttpOnly/SameSite cookies, bounded JWT lifetime, server-side admin/user token versions, logout/password revocation tests | Partial |
| V8 Authorization | Applicable | Central role/ownership dependencies and negative tests | Partial |
| V9 Self-contained Tokens | Applicable | Fixed algorithms, token type/role/version validation | Partial |
| V10 OAuth and OIDC | Not implemented in Community | Unified/enterprise SSO is outside the core login path | N/A |
| V11 Cryptography | Applicable | AES-256-GCM field envelopes, independent keys, rotation procedure | Partial |
| V12 Secure Communication | Applicable | TLS reverse-proxy requirement and private dependency networks | Partial/operator |
| V13 Configuration | Applicable | Production preflight, safe bind defaults, secret validation | Partial |
| V14 Data Protection | Applicable | Content-minimized logs, encrypted secrets, retention and backup guidance | Partial |
| V15 Secure Coding and Architecture | Applicable | Threat model, extension contract, CodeQL/Bandit/Ruff and review gates | Partial |
| V16 Security Logging and Error Handling | Applicable | Redaction and operational audit records | Partial; security-event coverage remains an improvement item |
| V17 WebRTC | No WebRTC feature | No WebRTC signaling or media processing | N/A |

An item may move from Partial only when each applicable ASVS requirement is
linked to an implementation, an automated or repeatable verification, an owner,
and dated evidence. Product documentation must not describe this tracker as an
ASVS certification.

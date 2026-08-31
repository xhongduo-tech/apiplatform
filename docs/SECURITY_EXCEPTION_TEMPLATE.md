# Security exception record

Copy this template into a restricted issue or an approved change record when a
release cannot remediate a specific security finding immediately. An exception
is evidence of a time-bounded risk decision, not proof that the finding is safe
or that a scanner is wrong.

## Identity and scope

- Exception ID:
- Finding, advisory, or CVE:
- Affected component and exact version/digest:
- Affected deployment or release candidate:
- Severity and scoring method:
- Date opened (UTC):
- Expiry date (UTC):
- Remediation release/date:
- Risk owner:
- Independent approver:

## Technical assessment

- Vulnerable code or package path:
- Preconditions and reachable attack path:
- Confidentiality, integrity, availability, safety, and cost impact:
- Evidence that the issue is or is not reachable in the shipped configuration:
- Customer/operator exposure:

## Temporary treatment

- Compensating controls:
- Detection and alerting:
- Rollback or containment procedure:
- Verification evidence and test date:
- Reassessment cadence:

## Closure

- Fix commit and release:
- Verification evidence:
- Closure date and approver:

The exception must be approved before release, have a named owner and finite
expiry, and be reassessed after any exposure or configuration change. Critical
and High exceptions require a reviewer other than the risk owner. Expiry blocks
the next release until the issue is fixed or a new assessment is independently
approved.

Exceptions cannot authorize known credentials or private data in source or
artifacts, an invalid/missing publisher signature or provenance record, an
unverified destructive migration, or a recovery path that has not passed the
required restore drill. Those conditions remain release blockers.

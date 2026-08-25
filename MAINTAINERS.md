# Maintainers

Open API Platform is bootstrapped by `@xhongduo-tech`. Until an organization
and additional maintainers exist, `.github/CODEOWNERS` assigns release and
security-sensitive paths to that account so review requests resolve correctly.
The project should migrate to the following role-based teams before granting
write access to additional maintainers:

| Team | Responsibility |
| --- | --- |
| `@open-api-platform/maintainers` | Releases, governance, cross-project review |
| `@open-api-platform/backend-maintainers` | Python API, database, gateway and operations |
| `@open-api-platform/frontend-maintainers` | Web console, accessibility and localization |
| `@open-api-platform/security-maintainers` | Private reports, threat review and disclosure |

Maintainers are expected to disclose conflicts of interest, keep security
reports private, require CI before merge, and use two-person review for release,
authentication, encryption, migration, and workflow changes. Membership changes
should be proposed in a pull request updating this file and approved by two
current project maintainers.

After those teams exist, replace the bootstrap account in `.github/CODEOWNERS`
with the matching organization teams. The repository host is the authoritative
source for current membership. This file deliberately avoids publishing
personal contact details.

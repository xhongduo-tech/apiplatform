# Community and Enterprise edition boundaries

Open API Platform uses an open-core, two-repository layout. This document is
the authoritative source boundary for maintainers, release automation, and
commercial builds.

## Repository ownership

| Repository | Visibility | Project-authored license | Contents |
| --- | --- | --- | --- |
| `apiplatform` | Public | Apache-2.0 | Gateway, compatibility APIs, local authentication, basic governance, verified backups, Compose deployment, monitoring, extension contracts |
| `apiplatform-enterprise` | Private | Proprietary commercial license | Current baseline: tenancy/RBAC APIs, audit, licensing, pgBackRest/PITR, Compose and Helm. Planned capabilities such as SSO/SCIM, ABAC, managed HA and a dedicated Enterprise UI remain private-roadmap work. |

With the exception of clearly attributed third-party material, every file in
this repository is Community-edition source. No proprietary implementation,
customer configuration, commercial license key, private package, or customer
deployment manifest may be committed here.

## Dependency direction

The public core never imports the Enterprise package. It exposes a versioned,
optional extension API; a commercial image explicitly loads compatible private
modules at startup. With no extension configured, the Community image behaves
exactly as the normal open-source distribution.

```text
apiplatform-enterprise ──depends on──> apiplatform
apiplatform             ──never imports──> apiplatform-enterprise
```

Security fixes, protocol compatibility fixes, migration safety, encryption,
basic backup integrity, and data-loss prevention in the core runtime must not
be withheld from the Community edition. Enterprise modules may add policy,
orchestration, integrations, compliance evidence, and support guarantees.

## Version compatibility

Each Enterprise release must declare an exact tested core range and extension
API version. The initial implemented release mapping is:

```text
Community core:  1.0.1
Enterprise:      1.0.1-ee.1
Compatible core: >=1.0.0,<1.1.0
Extension API:   1
```

Core migrations run before Enterprise migrations. Enterprise-owned tables use
a separate PostgreSQL schema or an unambiguous prefix, and the commercial data
plane must fail closed when its required schema or license cannot be verified.

## Change flow

1. Correct shared security and gateway defects in the public core first.
2. Publish and tag the tested Community release.
3. Update the Enterprise compatibility manifest to that immutable tag/digest.
4. Run Community tests plus Enterprise compatibility, migration, backup, and
   upgrade tests.
5. Publish combined commercial images from the private repository only.

Apache-2.0 notices from the Community core must remain present in every
commercial distribution. The commercial license governs only separately
authored Enterprise components; maintainers should obtain legal review before
changing licensing or distribution terms.

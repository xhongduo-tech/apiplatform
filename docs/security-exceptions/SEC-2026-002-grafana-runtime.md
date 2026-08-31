# SEC-2026-002 — Grafana upstream bundled-runtime findings

This is a time-bounded risk-acceptance record, not a claim that the findings
are fixed, unreachable, or compliant with an external standard. It applies
only to the exact image and restricted default deployment below. Approval of
the pull request by a reviewer other than the risk owner is required before
this record is effective; retain that approval URL in the release evidence.

## Identity and scope

- Exception ID: `SEC-2026-002`
- Findings: the exact 29 High-severity IDs and component scopes in
  [`security/trivy/grafana-13.2.0-high.yaml`](../../security/trivy/grafana-13.2.0-high.yaml)
- Affected component: Grafana 13.2.0 Alpine image, OpenSSL 3.5.7-r0, and 13
  bundled datasource executables
- Exact digest: `sha256:3fd54ae1214669f8355f065ec9f6445d5279a3d77095ab048ca045685272429b`
- Affected release candidate: Community 1.0.1
- Severity source: Trivy 0.70.0 with the 2026-08-31 vulnerability database;
  164 High occurrences, 29 unique IDs, and 65 unique
  ID/package/version/fixed-version component records. Every occurrence reports
  a dependency-level fixed version.
- Date opened: 2026-08-31
- Expiry timestamp: 2026-09-30T23:59:59Z
- Remediation target: replace the pinned image when Grafana publishes an
  artifact whose bundled components pass the gate, no later than expiry
- Risk owner: 徐鸿铎
- Independent approver: the protected-branch reviewer other than the risk
  owner; record the approval URL in release evidence before publication

## Technical assessment

The Grafana server binary and shipped Node packages have no findings in this
set. Two occurrences are in Alpine OpenSSL and concern an OpenSSL QUIC server
listener; the shipped Grafana configuration does not create one. The other
findings are in 13 bundled datasource executables. Only the Prometheus
datasource is provisioned, non-editable, and actively used by the shipped
dashboard against the trusted in-Compose Prometheus service. The other 12
affected datasources are not configured, but remain present in the image and
are not described as removed or universally unreachable.

Some findings may therefore enter an active plugin path. The restricted
network and identity boundary reduces exposure but does not correct the bundled
versions. Widening Grafana's bind address beyond a controlled management path,
enabling anonymous access or initial administrator creation, allowing plugin
administration/update, or configuring another datasource invalidates this
assessment and requires a new review before deployment.

## Risk impact and exposure

- Vulnerable package paths: the exact Alpine OpenSSL package PURLs and paired
  `linux/amd64`/`linux/arm64` bundled-datasource executable paths in the High
  exception file.
- Preconditions and reachable attack path: the OpenSSL finding requires a QUIC
  server listener; the bundled findings require Grafana to load and exercise an
  affected datasource path. Prometheus is active, so the plugin set is not
  treated as universally unreachable.
- Confidentiality, integrity, availability, safety, and cost impact: a Grafana
  process compromise could expose or falsify operational metrics and dashboard
  state, interrupt monitoring, pivot to services on the Compose network, or
  consume compute/network resources. No physical safety-control function is in
  scope, but loss of monitoring can delay incident detection.
- Customer/operator exposure: the shipped host bind is loopback-only and login
  is required. Publishing the port, enabling anonymous/initial-admin access,
  enabling plugin installation, or adding a datasource invalidates this record.

## Temporary treatment

### Compensating controls

- The host port binds to loopback by default; anonymous access and initial
  administrator creation are disabled.
- Plugin preinstallation, plugin administration, update checks, public-key
  retrieval, telemetry, and the news feed are disabled.
- The root filesystem is read-only, every Linux capability is dropped, and
  `no-new-privileges` is set. Only the data volume and bounded tmpfs are
  writable.
- Provisioned files and dashboards are read-only. The sole datasource is the
  internal Prometheus service and is not editable.
- CI keeps the Grafana all-Critical scan unfiltered. A separate fixable-High
  gate applies only the exact PURL/path scopes in the High exception file, so a
  future severity escalation is not silently suppressed by the Critical gate.

### Detection and alerting

- Docker health/restart state and Grafana logs are the minimum runtime signals;
  operators should alert on unexpected restarts, unhealthy status, login or
  datasource errors, and unexplained outbound/Compose-network connections. The
  Community deployment does not include a dedicated plugin exploit detector or
  SIEM forwarding destination.
- CI preserves the unfiltered report before blocking scans. Any new Critical is
  never suppressed, and any fixable-High ID/path scope, digest, control, or
  expiry drift fails the reviewed exception checker. Unfixable High findings
  remain visible in the unfiltered report but are not represented as blocked by
  this exception gate.

### Rollback or containment

- Grafana is not on the API request path. On suspicion, bind or firewall the
  port closed and stop Grafana while retaining its logs/data volume for
  investigation; the gateway can remain isolated and operational if its own
  trust boundary is unaffected.
- Replace the exact image digest, recreate the Grafana container, rotate any
  datasource or administrator credentials that were introduced by the
  operator, and complete a dashboard/datasource smoke test before reopening
  management access.

### Verification evidence and test date

- 2026-08-31: Trivy 0.70.0 scanned the exact digest for `linux/amd64` and
  `linux/arm64`; both produced the documented 164 High occurrences, 29 IDs and
  65 component records, and the exact path/PURL file left zero unexcepted High
  results. The Critical scan remained unfiltered and returned zero.
- 2026-08-31: the checker verified the loopback bind, disabled anonymous and
  initial-admin modes, disabled plugin/update/telemetry paths, read-only
  filesystem, zero capabilities, sole non-editable Prometheus datasource, and
  the severity-isolated CI gates.
- These checks validate the restricted baseline and suppression scope; they do
  not prove that the bundled dependencies are fixed.

### Reassessment cadence

- The unfiltered result count, scanner/database timestamp, exact digest,
  platform, filtered result, and approval URL must be retained in release
  evidence. Reassess on every database or digest change and at least weekly.
- The protected GitHub runner continuously gates the official `linux/amd64`
  release path. The two architecture-specific path scopes were also verified
  against `linux/arm64` on 2026-08-31, but that manual check does not turn the
  current amd64-only official release into a multi-architecture release.

## Closure

- Fix commit and release: pending upstream image refresh
- Verification evidence: pending replacement-image scan and dashboard smoke test
- Closure date and approver: pending

An expired record, changed digest, missing independent approval, newly
configured datasource, or weakened network/identity/container control blocks
release.

# Fly.io deployment for Sats on Ice

For current commands and verification evidence, see the [implemented Fly deployment guide](../design/fly-deployment.md) and [backup/restore guide](../design/wallet-backup.md). The research below records the earlier investigation and its evidence at that time.

Researched and updated 2026-09-19 against current primary documentation. Selected: Fly.io, one Machine with one persistent volume, CLI-created consistent SQLite backups and manual restore, and Fly-controlled automatic suspension with request-driven wake. Background payment work may wait until the next wake; application-controlled suspension and a separate wake scheduler are outside v1. Exact Machine size, region, mount path, and backup destination/frequency remain implementation or operator choices. Implementation update: `serve` now initializes a fresh database from environment configuration; see the [current local setup design](../design/local-setup.md). No Fly account, credentials, deployment, or live infrastructure was accessed.

## Persistent storage and Machine count

Fly Machine root filesystems are ephemeral. A Fly Volume supplies persistent local storage on one physical server in one region; it is not shared network storage. A volume attaches to one Machine, and Fly does not replicate data between volumes. Single-Machine deployments can experience downtime during deploys or host failures. [Fly Volumes](https://fly.io/docs/volumes/overview/).

Selected topology: one Machine with one mounted volume, containing the complete SQLite database, including identity history, seed, proofs, and destination payout indices; runtime mint URL and threshold are environment-only. `/data/sats-on-ice.sqlite` is a possible path, not an existing configuration. Replicating Machines without a wallet/database coordination design would create independent or stale wallet state, not transparent failover.

Fly Launch ordinarily creates two Machines for service process groups, **but explicitly creates only one when the process group mounts volumes**. `fly launch --ha=false` and `fly deploy --ha=false` express single-Machine intent on first deploy or after scaling to zero. Existing scale is normally retained on subsequent deploys. Inspect the resulting count rather than relying on a generic starter configuration. [Availability defaults](https://fly.io/docs/apps/app-availability/), [Machine scaling](https://fly.io/docs/launch/scale-count/).

## Suspension: Fly-controlled policy selected 2026-09-19

**Verified platform behavior.** `auto_stop_machines = "suspend"`, `auto_start_machines = true`, and `min_machines_running = 0` permit idle suspension and request-driven wake. The minimum-running setting applies only in the primary region. Fly Proxy checks every few minutes; one Machine with zero proxy-visible load can suspend. It wakes for an incoming request to the app. [Autostop behavior](https://fly.io/docs/reference/fly-proxy-autostop-autostart/), [service settings](https://fly.io/docs/reference/configuration/#the-http_service-section).

Fly explicitly says background work does not count toward proxy load and documents no application busy signal that vetoes autostop. Therefore outgoing mint WebSockets, polling, and timers must not be treated as a supported keep-awake mechanism. This differs from long-lived incoming connections handled by the proxy. [Background-task lifecycle](https://fly.io/docs/blueprints/long-running-tasks/).

No minimum idle-duration setting was found in the current app configuration or Machines API reference. The documented HTTP `idle_timeout` closes idle connections; it is not a delayed-suspension setting. Do not promise an exact suspension deadline or invent `min_idle_timeout`. [Configuration](https://fly.io/docs/reference/configuration/), [Machines API schema](https://fly.io/docs/machines/api/machines-resource/).

Suspend freezes process memory and CPU state, normally resuming without rerunning application initialization. It does not continue executing timers or background tasks. Snapshots may be discarded during deploys, migration, or maintenance, forcing a cold start. Volume data survives either path. Existing connections may have closed remotely; reconnect handling and brief clock skew require attention. Resume is generally faster than cold boot, not a guaranteed latency. [Suspend/resume](https://fly.io/docs/reference/suspend-resume/).

**Critical application inference.** After LNURL returns a mint-issued invoice, the sender pays the mint directly. If Sats on Ice has suspended, that payment supplies no documented inbound Fly Proxy request to wake it. Claiming ecash and threshold processing can therefore wait indefinitely for a new app request or explicit wake. No mint-to-app wake webhook is part of the selected flow. This follows from the selected payment architecture and Fly's request-triggered wake model above.

**Coco evidence and unknowns.** Coco documents WebSocket watching with polling fallback, and `initializeCoco()` rechecks pending operations and recovers executing operations. A warm resume does not itself invoke `initializeCoco()`. Whether Coco reconnects, catches up all missed state, and triggers threshold processing correctly after a long Fly suspension remains untested; startup recovery alone does not establish it. [Coco mint operations](https://cashubtc.github.io/coco/pages/mint-operations.html).

**Selected policy:** allow Fly Proxy suspension and accept delayed processing until the next incoming request or explicit wake. See [the suspension ADR](../adr/0007-fly-controlled-suspension.md). Warm-resume reconciliation remains a verification requirement, not a proven capability.

**Alternatives investigated during the interview:**

- Keep `auto_stop_machines = "off"` for continuous processing.
- Allow proxy suspension and explicitly accept delayed processing until the next external wake (**selected**).
- Disable proxy autostop, retain autostart, and let the app suspend itself only when issued invoices and payout operations are resolved. Fly supports self-suspension through the guest `/.fly/api` Unix socket using the Machine suspend endpoint without a token. [Self-suspension mechanism](https://fly.io/docs/reference/suspend-resume/).

The unselected third option is a feasible design inference, not an existing Coco feature. It needs application logic to establish quiescence, coordinate concurrent requests with suspension, and handle mint outages or unresolved operations. Waiting until an invoice's local expiry alone is not proof that its remote payment/claim state is settled. It preserves the one-Machine model but can remain awake for long invoice expiries or pending payouts.

**Scheduled wake.** Native Machine schedules run on approximate hourly, daily, weekly, or monthly cycles; hourly is the lowest documented cadence. The suspend requirements exclude Machines with a schedule configured. A separate scheduler issuing HTTP or an authenticated Machine-start request is therefore an alternative design, not a native timer inside the suspended process. [Native schedules](https://fly.io/docs/machines/flyctl/fly-machine-run/#start-a-machine-on-a-schedule), [suspend requirements](https://fly.io/docs/reference/suspend-resume/).

**Cost effect.** Suspended Machines have no CPU/RAM charges, with the same storage-only Machine billing as stopped Machines. Persistent volumes, root filesystem storage, applicable snapshot storage, and separately allocated billable IP resources still cost money. Shared IPv4 and dedicated IPv4 have different pricing; suspension is not a zero-cost deployment. [Suspend billing](https://fly.io/docs/reference/suspend-resume/), [resource pricing](https://fly.io/docs/about/pricing/).

## HTTPS and runtime domain

Fly's custom-domain documentation tells applications running directly on Fly to read the incoming `Host` header. Fly also supplies `X-Forwarded-Proto` for the original client protocol. These support the selected policy of deriving the domain from Host and generating HTTPS callbacks. [Custom-domain handling](https://fly.io/docs/networking/custom-domain/), [request headers](https://fly.io/docs/networking/request-headers/).

Proposed service settings: match Bun's listening port with Fly's `internal_port`, bind Bun to `0.0.0.0`, and set `force_https = true`. Fly's HTTP service handles public ports 80/443. A custom public domain requires its DNS/certificate configuration; the existing `.fly.dev` address is another possible public hostname. Host is request input, so origin formatting/validation must remain explicit. [Deployment networking](https://fly.io/docs/getting-started/troubleshooting/), [HTTP service configuration](https://fly.io/docs/reference/configuration/#the-http_service-section), [custom domains](https://fly.io/docs/networking/custom-domain/).

## CLI setup and updates

**Do not use `release_command` to configure or migrate this SQLite database.** It runs in a temporary Machine without persistent volumes. Fly directs volume-dependent initialization toward the volume-attached Machine's startup command or entrypoint. [Release-command behavior](https://fly.io/docs/reference/configuration/#run-one-off-commands-before-releasing-a-deployment).

`fly ssh console --machine <id> -C '<application CLI command>'` executes a command on an existing running Machine and therefore can reach its mounted database. This supports local inspection; runtime configuration changes now come from the deployment environment and take effect on restart. [SSH command reference](https://fly.io/docs/flyctl/ssh-console/).

Bootstrap implementation: set `SOI_MINT_URL`, `SOI_PAYOUT_THRESHOLD_SATS`, and, for a fresh database, `SOI_USERNAME` and `SOI_XPUB`; run `serve` with `SOI_DATABASE` on the mounted volume and `SOI_HOSTNAME=0.0.0.0`. The server creates or selects local identity state and preserves the seed and destination counters on restart. `setup` remains an optional offline preview. Seed generation occurs on the mounted-volume Machine, not during image build or a release command. Fly deployment itself remains unverified.

## Snapshots and backup consistency

Fly takes daily volume snapshots by default, retaining five days; retention can be set from 1 to 60 days. On-demand snapshots are available, and restoration creates a new volume. Writes since the most recent snapshot may be lost after a host failure, so Fly recommends additional backups for frequently changing data. [Volume snapshots](https://fly.io/docs/volumes/snapshots/).

SQLite's online backup API produces a consistent database snapshot while the source can remain in use. A database-aware backup, or an offline copy after cleanly stopping writers, is preferable to copying only a live database file. [SQLite backup documentation](https://www.sqlite.org/backup.html).

Selected backup interface: CLI-created consistent SQLite backup and manual restore. Application implication: backups include spendable secrets and must preserve seed, proofs, identity history and destination counters together, with deployment environment configuration retained separately. Restoring a consistent but old database can still restore an old payout index or omit recent operations; filesystem consistency alone does not establish wallet recovery correctness. Neither restored Coco settlement state nor payout-index recovery was tested. Backup destination, frequency, and exact manual restore procedure remain open; daily volume snapshots alone do not settle them.

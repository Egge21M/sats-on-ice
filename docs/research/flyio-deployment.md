# Fly.io deployment for Sats on Ice

For current commands and verification evidence, see the [implemented Fly deployment guide](../design/fly-deployment.md) and [backup/restore guide](../design/wallet-backup.md). The research below records the earlier investigation and its evidence at that time.

Originally researched 2026-09-19; deployment policy updated 2026-09-29. The current model is a regular server with persistent storage, running continuously or with full shutdown and startup. Fly.io is an optional host with one Machine and one persistent volume, CLI-created consistent SQLite backups and manual restore. The former suspension policy has been removed; see [ADR 0006](../adr/0006-server-deployment.md) and [ADR 0007](../adr/0007-shutdown-and-startup.md). The remaining research records platform facts at the original investigation date; the linked design guides contain subsequent implementation and verification.

## Persistent storage and Machine count

Fly Machine root filesystems are ephemeral. A Fly Volume supplies persistent local storage on one physical server in one region; it is not shared network storage. A volume attaches to one Machine, and Fly does not replicate data between volumes. Single-Machine deployments can experience downtime during deploys or host failures. [Fly Volumes](https://fly.io/docs/volumes/overview/).

Selected topology: one Machine with one mounted volume, containing the complete SQLite database, including identity history, seed, proofs, and destination payout indices; runtime mint URL and threshold are environment-only. `/data/sats-on-ice.sqlite` is a possible path, not an existing configuration. Replicating Machines without a wallet/database coordination design would create independent or stale wallet state, not transparent failover.

Fly Launch ordinarily creates two Machines for service process groups, **but explicitly creates only one when the process group mounts volumes**. `fly launch --ha=false` and `fly deploy --ha=false` express single-Machine intent on first deploy or after scaling to zero. Existing scale is normally retained on subsequent deploys. Inspect the resulting count rather than relying on a generic starter configuration. [Availability defaults](https://fly.io/docs/apps/app-availability/), [Machine scaling](https://fly.io/docs/launch/scale-count/).

## Continuous operation or full stop/start

The current template uses `auto_stop_machines = "off"`, `auto_start_machines = true` and `min_machines_running = 1`. Optional idle stopping uses `auto_stop_machines = "stop"` with `min_machines_running = 0`; a later incoming request starts a new process. The minimum-running setting applies in the primary region. This fits the application's startup recovery lifecycle. [Fly autostop](https://fly.io/docs/reference/fly-proxy-autostop-autostart/), [service settings](https://fly.io/docs/reference/configuration/#the-http_service-section).

Background mint traffic does not count toward proxy load. Once an invoice has been returned, the payer sends payment to the mint directly; that payment does not start a stopped Sats on Ice process. Choosing idle stops therefore accepts delayed ecash claims and payout processing until an app request or explicit start. The application adds no stop scheduler or background-work veto.

Memory-preserving suspension is unsupported. Configure a full stop so the old process exits, SQLite persists wallet state and the next start constructs a new Coco manager. See the [recovery guide](../design/payment-recovery.md) for Coco's startup lifecycle and dependency limitations.

## HTTPS and runtime domain

Fly's custom-domain documentation tells applications running directly on Fly to read the incoming `Host` header. Fly also supplies `X-Forwarded-Proto` for the original client protocol. These support the selected policy of deriving the domain from Host and generating HTTPS callbacks. [Custom-domain handling](https://fly.io/docs/networking/custom-domain/), [request headers](https://fly.io/docs/networking/request-headers/).

Proposed service settings: match Bun's listening port with Fly's `internal_port`, bind Bun to `0.0.0.0`, and set `force_https = true`. Fly's HTTP service handles public ports 80/443. A custom public domain requires its DNS/certificate configuration; the existing `.fly.dev` address is another possible public hostname. Host is request input, so origin formatting/validation must remain explicit. [Deployment networking](https://fly.io/docs/getting-started/troubleshooting/), [HTTP service configuration](https://fly.io/docs/reference/configuration/#the-http_service-section), [custom domains](https://fly.io/docs/networking/custom-domain/).

## CLI setup and updates

**Do not use `release_command` to configure or migrate this SQLite database.** It runs in a temporary Machine without persistent volumes. Fly directs volume-dependent initialization toward the volume-attached Machine's startup command or entrypoint. [Release-command behavior](https://fly.io/docs/reference/configuration/#run-one-off-commands-before-releasing-a-deployment).

`fly ssh console --machine <id> -C '<application CLI command>'` executes a command on an existing running Machine and therefore can reach its mounted database. This supports local inspection; runtime configuration changes now come from the deployment environment and take effect on restart. [SSH command reference](https://fly.io/docs/flyctl/ssh-console/).

Bootstrap implementation: set `SOI_MINT_URL`, `SOI_PAYOUT_THRESHOLD_SATS`, and, for a fresh database, `SOI_USERNAME` and `SOI_XPUB`; run `serve` with `SOI_DATABASE` on the mounted volume and `SOI_HOSTNAME=0.0.0.0`. The server creates or selects local identity state and preserves the seed and destination counters on restart. `setup` remains an optional offline preview. Seed generation occurs on the mounted-volume Machine, not during image build or a release command. Subsequent controlled deployment evidence is recorded in the [Fly guide](../design/fly-deployment.md#verification-record).

## Snapshots and backup consistency

Fly takes daily volume snapshots by default, retaining five days; retention can be set from 1 to 60 days. On-demand snapshots are available, and restoration creates a new volume. Writes since the most recent snapshot may be lost after a host failure, so Fly recommends additional backups for frequently changing data. [Volume snapshots](https://fly.io/docs/volumes/snapshots/).

SQLite's online backup API produces a consistent database snapshot while the source can remain in use. A database-aware backup, or an offline copy after cleanly stopping writers, is preferable to copying only a live database file. [SQLite backup documentation](https://www.sqlite.org/backup.html).

Selected backup interface: CLI-created consistent SQLite backup and manual restore. Application implication: backups include spendable secrets and must preserve seed, proofs, identity history and destination counters together, with deployment environment configuration retained separately. Restoring a consistent but old database can still restore an old payout index or omit recent operations; filesystem consistency alone does not establish wallet recovery correctness. Neither restored Coco settlement state nor payout-index recovery was tested. Backup destination, frequency, and exact manual restore procedure remain open; daily volume snapshots alone do not settle them.

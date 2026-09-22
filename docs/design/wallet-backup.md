# Complete wallet backup and manual restore

Implements [issue #6](https://github.com/Egge21M/sats-on-ice/issues/6). The persistence boundary follows [ADR 0008](../adr/0008-shared-database-separate-migrations.md): one SQLite snapshot contains the seed, identities, destinations, active reference, Coco state at every stored mint and both migration histories. Runtime environment configuration remains separate.

## Export and retain

Run on the database host as its owner, with enough disk space for a complete snapshot:

```sh
bun run cli --database ./data/sats-on-ice.sqlite backup ./backups/wallet-2026-09-22.sqlite
```

For the packaged application, use `bun /app/dist/index.js --database /data/sats-on-ice.sqlite backup /data/backups/wallet-2026-09-22.sqlite`, adapting paths to the deployment. `SOI_DATABASE` also works. No other `SOI_*` variables are needed; backup does not read the runtime policy, select identities, contact mints, initialize repositories or start a manager. It can run beside the single active server or with that server stopped.

The exporter opens an existing source read-only and uses SQLite's [`VACUUM INTO`](https://www.sqlite.org/lang_vacuum.html). This produces a consistent snapshot including committed WAL contents while another connection writes. Uncommitted changes are excluded. All tables are copied rather than selecting known wallet rows, so keysets, deterministic counters, proofs, quotes, operations and future tables are retained together. A database snapshot can capture a legitimate intermediate operation state: application index allocation and subsequent Coco writes are separate transactions. It does not represent an atomic payment or freshly reconciled balance.

Output is written into a private temporary directory beside the destination, with a `0600` file. After SQLite integrity and foreign-key checks, the file is synced and published atomically using a hard link, then the parent directory is synced. Publication fails if any destination already exists, including empty files and symlinks. The source and its journal paths are rejected as destinations. The destination filesystem must support hard links and directory syncing; Fly's local volume filesystem fits this design. New parent directories use `0700`; existing directory permissions are unchanged. Source permissions and schemas are unchanged. Locks have a five-second busy timeout; failures return a nonzero exit status with a safe diagnostic. A crash before publication can leave a private `.soi-backup-*` directory, which is not a completed backup. Ordinary failures clean up staging files. Use a fresh filename when retrying.

The integrity check detects SQLite structural damage, not whether funds remain spendable at a mint or all logical application records are present. Preserve the original if validation fails; do not treat an error as an empty wallet. Application validation still runs on the restored working copy.

The completed backup is one standalone file; it needs no source WAL/SHM files or `.status` socket directory. Record the export time and application revision alongside it. Keep the backup unchanged and copy it for inspection or restoration. A backup includes the **unencrypted Cashu seed and spendable ecash**: restrict access, use encrypted storage for retained/downloaded copies, and keep a copy away from the host/volume. Successful local export alone does not protect against losing that volume. Record these settings separately in secure owner-controlled storage:

- `SOI_MINT_URL` and `SOI_PAYOUT_THRESHOLD_SATS` (required again after restoration).
- Intended username/xpub overrides, or the decision to omit them and reuse the saved active identity.
- Database mount/path, listen host/port, HTTPS proxy/domain configuration and application revision.

No environment file or deployment secret is embedded in the snapshot. Coco's old mint URLs remain wallet history, not a substitute for selecting the runtime mint.

## Manual restoration

1. Stop the server and disable its supervisor's restart/request-driven wake while preparing the restore. Stop any other instance of this wallet, even if it uses a different file path. Do not run the original and restored copies together: they share the same seed, proofs and operation history. On Fly, use a maintenance procedure that keeps payment serving disabled while accessing the volume; merely stopping an auto-starting Machine is insufficient.
2. Deliberately choose the backup after reviewing its date, application version and known activity since export. Preserve the current database with all its existing WAL/SHM/journal files in place. Retain the backup unchanged. Do not overwrite the current file, discard its WAL or mix journal files from different snapshots.
3. Copy the selected backup into a fresh working directory. The following commands run on the database host with the application stopped; replace the backup path with the chosen file and use the matching application build. `data` is an existing persistent directory:

```sh
umask 077
restore_dir="$(mktemp -d ./data/restore-XXXXXX)"
install -m 600 ./backups/wallet-2026-09-22.sqlite "$restore_dir/wallet.sqlite"
export SOI_DATABASE="$restore_dir/wallet.sqlite"
export SOI_MINT_URL=https://your-mint.example
export SOI_PAYOUT_THRESHOLD_SATS=100000
unset SOI_USERNAME SOI_XPUB
bun run cli status
bun run cli verify
```

4. Review environment files (including Bun's automatically loaded `.env`), service configuration and Fly variables/secrets as well as the current shell. Clearing shell variables alone does not remove overrides from those sources. With username/xpub absent everywhere, the restored active values are reused. Supplying either overrides that component and `serve` selects or creates its matching identity. An existing normalized destination retains its saved shared counter; a new destination begins at zero. Always compare the first payout address with the intended wallet and review pending operations' recorded addresses before enabling payments.
5. `status` observes the restored copy without migrations or payment processing. `verify` validates local state and can apply the existing migration lifecycle, but starts no manager. Check the active identity, all destinations you intend to reuse, their next indices, current/earlier-mint funds and pending operations. Invalid or incomplete stored seed/identity state must be investigated; do not delete it or retry against a missing path, since `serve` initializes a fresh database at a new path. A zero/local balance is not proof of recovery or readiness.
6. Point the supervisor/deployment's `SOI_DATABASE` at this inspected working copy on persistent storage, retain the reviewed runtime environment, and start **one** `serve` process. For a manual local start, run `bun run cli serve` in the shell above. `serve` opens the existing application/Coco lifecycle and recovers saved operations. Submitted payouts retain recorded destinations; a newly selected destination governs new allocations. Earlier-mint funds remain at those mints without automatic migration or new sweeps, while existing operations may recover. Inspect status and server diagnostics as recovery proceeds. Re-enable public traffic/request wake only after the restored service is ready.

Restoration never rewinds the mint or Bitcoin. A consistent older backup can omit later receipts, proof changes, submissions, identity selections and allocated payout indices. Missing operations are not automatically reconstructed; proofs in the file may already have been spent. Old destination counters can permit address reuse. Keep newer original state for investigation and do not assume restarting an older copy recovers post-backup activity. Seed-only recovery, arbitrary state merging and automatic recovery of missing records are outside this implementation. Coco 2.0 can retain unresolved operations; its known factory failure-cleanup limitation is described in the [receiving lifecycle](lightning-receiving.md#implementation).

## Fly download and additional snapshots

For an already deployed single Machine, export on its attached volume using the packaged command above. Download the completed file from that same Machine, replacing the example app/Machine values and paths:

```sh
umask 077
fly ssh sftp get --app YOUR_APP --machine YOUR_MACHINE /data/backups/wallet-2026-09-22.sqlite ./wallet-2026-09-22.sqlite
chmod 600 ./wallet-2026-09-22.sqlite
```

The [`fly ssh sftp get` reference](https://fly.io/docs/flyctl/ssh-sftp-get/) documents file download and Machine selection. Compare a SHA-256 checksum at both ends before storing the copy, using `sha256sum` or the host's equivalent. Store deployment configuration separately. Restoring on Fly requires a deliberate stopped-application maintenance procedure and a working copy on the mounted volume; do not start a second wallet server just to inspect a backup.

[Fly volume snapshots](https://fly.io/docs/volumes/snapshots/) provide additional coverage. Review their retention and completion state; snapshots may omit activity since capture. They do not replace owner-downloaded database exports and separately retained configuration. This slice neither provisions Fly resources nor installs an off-platform backup schedule. Actual deployment and suspension evidence belong to issues #7 and #8.

## Repeatable verification

```sh
bun test tests/backup.test.ts tests/cli.test.ts
```

The tests use real SQLite, Coco's normal lifecycle, and the controlled mint fixture without real funds:

1. Commit a destination counter to WAL, then hold an uncommitted counter/identity update on a second connection. Export includes the committed state and every table, excludes the uncommitted changes, leaves the writer untouched and uses private output permissions.
2. Reject existing files (including empty ones), symlinks, hard links, source journal paths, missing/corrupt databases and foreign-key violations. Failure publishes no partial snapshot and does not initialize a missing source. CLI exports require no runtime policy and never print seed material.
3. Receive 1,000 sats at the original mint and leave a payout pending at `/0/0`; keep 400 further sats spendable. Create another identity sharing that destination, then a third identity at a second destination and mint. Leave another 1,000-sat payout pending and 200 sats spendable there, plus an unpaid 11-sat receiving invoice. Export through a separate CLI process while the server remains active.
4. Restore the complete backup to a new path. Offline status leaves its full table digest unchanged and reports both reservations, balances and saved identity/index. Settle both payouts and pay the saved invoice while the application is stopped. Start the restored database with username/xpub omitted: Coco reconciles through its normal lifecycle without another submission, preserving the seed, history and per-destination counters. The first mint has 403 sats and the second 214 sats after refunded change and the claim.
5. Switch back to the original identity/destination. An additional 600-sat receipt starts the next payout at `/0/1`, advancing only that destination's counter to two. The other destination remains at one and no new sweep is initiated at the previous mint. The retained backup remains unchanged.

These are controlled local export/restore checks, not evidence of live Lightning routing, Bitcoin broadcast, Fly deployment or warm-resume correctness.

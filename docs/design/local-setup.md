# Environment configuration and persistent identity state

Runtime configuration comes from the environment. SQLite stores identity history, destination counters, the last active identity, and wallet state. This supersedes the CLI-first, database-owned configuration introduced by [PR #9](https://github.com/Egge21M/sats-on-ice/pull/9); see [ADR 0004](../adr/0004-sqlite-configuration-with-cli.md).

## Runtime configuration

`SOI_MINT_URL` and `SOI_PAYOUT_THRESHOLD_SATS` are required on every invocation and are never saved as application settings. Coco still persists mint URLs with its own proofs, quotes and operations. `SOI_USERNAME` and `SOI_XPUB` are required on a fresh database; afterward, either omitted value reuses the corresponding value of the last active identity. Empty or invalid values are errors, not requests to fall back.

`src/config.ts` validates and normalizes the environment. Mint URLs use HTTP(S), exclude credentials/query/fragment, and drop trailing slashes. Thresholds are positive safe-integer whole sats with decimal-digit input. Usernames use 1–64 lowercase letters, digits, dots, underscores or hyphens and begin with a letter. Destination keys are Bitcoin mainnet native SegWit account xpub/zpub exports at depth 3 with a hardened account index; equivalent encodings normalize to one xpub. Private keys, testnet keys, descriptors and other account formats are unsupported.

`SOI_DATABASE`, `SOI_HOSTNAME` and `SOI_PORT` configure the process, with defaults `./data/sats-on-ice.sqlite`, `127.0.0.1` and `3000`. The corresponding CLI flags override these process defaults. No domain is stored: HTTPS URLs are derived from the public Host header.

## Stored state and selection

| Table | Responsibility |
| --- | --- |
| `soi_destination` | Unique normalized `xpub` and `next_payout_index` |
| `soi_identity` | Unique `(username, destination_id)` pair; foreign key to destination |
| `soi_active_identity` | Singleton reference to the last selected identity |
| `soi_wallet_secret` | Singleton 64-byte Cashu seed |
| `soi_migrations` | Application migration history |
| `coco_cashu_*` | Coco-owned wallet state and migration history |

`InstanceStore` resolves or creates a destination and identity, updates the active reference, and creates the seed only for a fresh instance. These writes share an immediate SQLite transaction. Changing username reuses the destination counter; changing xpub selects its own counter; switching back reuses existing rows and resumes their counters. Changing mint or threshold does not create an identity or replace the seed. Missing seed material or incomplete stored selection is an error; existing wallet state is never adopted with a replacement seed.

A running server captures its selected destination ID. Payout allocation derives `/0/index` and increments that destination's counter in an immediate transaction before mint interaction. A later offline identity selection cannot redirect that server's allocations. Indices below `2^31` are derivable; `2^31` is retained as the exhausted-sequence marker. Allocation never checks external address history, and failed attempts do not roll the index back.

## Startup and local inspection

`serve` calls `openInstance` to initialize or select identity state automatically, then validates mint capabilities and initializes Coco. A separate setup command is not required. Valid environment changes select state rather than causing a configuration-mismatch failure. New payment routes and payout attempts use the captured environment configuration. Other-mint balances remain in Coco without automatic sweeps or migration; existing submitted operations retain their recorded destinations and can recover through Coco.

`setup` is an optional offline initialization/selection command and prints an address preview. `verify` opens an existing database and resolves environment overrides plus the persisted fallback without creating or activating identities. Verification of a requested identity that has never been initialized fails with guidance to run setup or serve. Both commands read repositories directly without starting Coco workers, recovery or mint requests. They may apply migrations.

The local balance sums `proofRepository.getAvailableProofs(mintUrl, { unit: "sat" })` using bigint arithmetic. Reserved, inflight, spent and non-sat proofs are excluded; other-mint funds are excluded from this selected-mint balance. The seed is validated but never printed. Previewing `/0/0` consumes no index and does not establish that the account has no earlier usage.

## Migration and verification

Migration `0001_env_identity_destinations.sql` copies the old singleton's canonical xpub and exact next index into `soi_destination`, preserves its identity ID and username, creates the active reference, and drops `soi_settings`. The Cashu seed and Coco tables are untouched. Supply mint URL and threshold in the environment before upgrading; their previous database values are not retained as runtime defaults.

Tests use real temporary SQLite databases and controlled mint HTTP servers. They cover repeated startup, normalized key reuse, partial identity overrides, switches and switch-back counters, transactional rollback, missing seeds, foreign keys and uniqueness, exact balance filtering, env-based CLI invocation, legacy migration (including an exhausted counter), and preservation of seed/proofs/Coco migration history. Receiving and payout tests cover startup without setup, changed thresholds, and mint/identity switching with pending operations and remaining old-mint funds.

Dependencies and supported Bun version are pinned in `package.json` and `bun.lock`. `bun run build` bundles `index.ts` and copies the committed migration directory next to it; ship both. The application restricts the database, WAL and SHM files to mode `0600` and new data directories to `0700`. Backups must preserve wallet state consistently and retain the deployment environment separately. Live mint interoperability, Fly deployment and warm-resume behavior remain separate verification work.

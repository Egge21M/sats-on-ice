# Local identity and Cashu wallet setup

This document records the design implemented by [PR #9](https://github.com/Egge21M/sats-on-ice/pull/9), including its mint URL normalization fix, against [setup ticket #2](https://github.com/Egge21M/sats-on-ice/issues/2). The implementation provides local `setup` and `verify` commands for one owner, one identity and one configured Cashu mint. The [glossary](../../CONTEXT.md) defines the domain terms; the [README](../../README.md) provides the operator walkthrough.

Subsequent receiving work is recorded in the [receiving design](lightning-receiving.md). It adds `serve` and active payment processing, and closes the baseline WAL/SHM permission gap described below by restricting existing sidecars before reopening the database. Statements below about future receiving work and the original permission limitation describe the PR #9 baseline.

## Dependencies

These are the selected versions for this slice, not a claim about the latest available releases. [package.json](../../package.json) is authoritative for direct dependencies and the Bun version; [bun.lock](../../bun.lock) records the resolved dependency graph. Install with `bun install --frozen-lockfile`.

| Dependency | Selected version | Responsibility |
| --- | --- | --- |
| Bun / `@types/bun` | `1.3.14` / `1.3.14` | Runtime, `bun:sqlite`, test runner, bundler and runtime types |
| `typescript` | `5.9.3` | Static typechecking |
| `@cashu/coco-core` / `@cashu/coco-sqlite-bun` | `2.0.0` / `2.0.0` | Cashu wallet APIs and repositories on the caller-owned Bun SQLite connection |
| `@cashu/cashu-ts` | `5.0.0-rc.4` | Coco's exact underlying Cashu dependency and the adapter's peer requirement; resolved through Coco rather than declared directly by the application |
| `drizzle-orm` / `drizzle-kit` | `0.45.2` / `0.31.10` | Typed application schema and queries, and generated SQL migrations |
| `zod` | `4.6.5` | Reusable validation of setup input and decoded stored configuration, including URL normalization |
| `commander` | `15.0.0` | CLI commands, options and help |
| `@scure/bip32` / `@scure/btc-signer` | `2.4.0` / `2.4.1` | Extended public key parsing, child derivation and native SegWit addresses |
| `@scure/bip39` | `2.4.0` | Cashu seed generation |

The Bun adapter implements the runtime choice in [ADR 0003](../adr/0003-bun-and-local-sqlite.md). Drizzle supplies typed access to application tables and reviewable migrations; Zod supplies validation that can be reused outside the CLI. The Scure pair was exercised against public BIP84 vectors during [address research](../research/bitcoin-address-history.md) and in this PR's tests. Coco's local integration is verified at these versions; live mint interoperability and payment recovery are separate verification work.

## Configuration boundary

[src/cli.ts](../../src/cli.ts) parses arguments with Commander and calls [src/setup.ts](../../src/setup.ts). [src/config.ts](../../src/config.ts) owns reusable Zod schemas; [ConfigStore](../../src/storage/config-store.ts) decodes the JSON settings and validates them by their known keys together with the stored identity. SQLite enforces structural constraints such as singleton identity and seed rows and an integer next payout index.

The username contains 1–64 lowercase letters, digits, dots, underscores or hyphens and starts with a letter or digit. The threshold is a positive safe-integer number of whole satoshis; its CLI representation accepts digits rather than permissive numeric coercion. No public domain is stored: deriving that domain from the request remains a server responsibility under [ADR 0005](../adr/0005-username-identities-and-runtime-domain.md).

Mint URLs use HTTP(S) and reject credentials, query strings and fragments, including empty `?` and `#` suffixes. Zod's `z.url({ protocol: /^https?$/, normalize: true })` normalizes the URL; an application transform removes every trailing slash while preserving internal path separators. For example, `https://MINT.example:443/cashu///` becomes `https://mint.example/cashu`, and subsequent parsing or Coco normalization leaves that value unchanged. Localhost and IP-address mints remain valid; the README recommends HTTPS for remote mints.

[src/destination.ts](../../src/destination.ts) accepts Bitcoin mainnet account xpub/zpub exports at depth 3 with a hardened account index, validates the actual extended key and stores equivalent encodings as a canonical xpub. Private keys, testnet keys, other versions, master keys, receiving-branch exports and descriptors are unsupported. The fixed derivation policy is native SegWit at `/0/index`; parsing the key cannot establish its full origin or intended address type, so the owner must compare the `/0/0` preview with their destination wallet.

New setup validates inputs before creating a database, then creates the seed, settings and identity together. Repeated setup with equivalent canonical inputs reopens the same state; any different username, threshold, mint or destination key is rejected. Username and threshold updates remain planned under [ADR 0004](../adr/0004-sqlite-configuration-with-cli.md), while mint and destination key stay fixed for existing wallet state.

## Persistence and initialization

[ADR 0008](../adr/0008-shared-database-separate-migrations.md) records the choice to share one database while separating table ownership.

| Owner | Tables | Contents / migration history |
| --- | --- | --- |
| Application / Drizzle | `soi_settings` | JSON values for mint URL and payout threshold |
| Application / Drizzle | `soi_identity` | Singleton username, canonical destination key and next payout index |
| Application / Drizzle | `soi_wallet_secret` | Singleton 64-byte Cashu seed, separate from displayable settings |
| Application / Drizzle | `soi_migrations` | Applied application SQL migrations |
| Coco | `coco_cashu_*` | Wallet repositories, with `coco_cashu_migrations` tracking Coco migrations |

[src/storage/database.ts](../../src/storage/database.ts) owns the connection, enables WAL, foreign keys and a busy timeout, and applies the committed application migrations. Drizzle's schema covers only application tables; Coco's repositories own access to wallet data. Schema changes use `bun run db:generate --name=<change>` and committed SQL/metadata, rather than schema push against the shared file.

The setup check and initial seed/settings/identity inserts run inside one `IMMEDIATE` transaction. A fresh BIP39 mnemonic generated with 256 bits of entropy is converted to a 64-byte seed; the application persists the seed and does not persist or display the mnemonic. It initializes the identity's next payout index to zero, then runs Coco migrations using the same connection and gives the persisted seed to Coco through `seedGetter`.

If the application transaction fails, all three initial writes roll back. If Coco initialization fails after that transaction commits, another invocation can retry with the same seed. Incomplete or invalid stored setup is rejected, and setup refuses to generate a replacement seed when Coco tables already exist without application state. These checks protect against silent reinitialization; they do not prove that any otherwise valid seed matches every persisted wallet record.

The main database contains unencrypted seed material and spendable ecash. New directories use `0700` and the main file is set to `0600`; existing directories and pre-existing WAL/SHM files are not chmodded by this implementation. A complete backup needs a consistent SQLite snapshot, since copying only an open main file can omit WAL contents; the backup command and restore workflow remain in [ticket #6](https://github.com/Egge21M/sats-on-ice/issues/6). Sharing the file does not make later Coco operations atomic with application payout-index changes.

## Local verification and wallet lifecycle

`verify` opens an existing database and validates its setup; it refuses a missing database. Both commands may apply database migrations, so local inspection is not a read-only SQLite connection. [src/wallet.ts](../../src/wallet.ts) initializes `SqliteRepositories`, constructs Coco's `Manager` and calls `initPlugins()` without invoking startup recovery or starting watchers or processors, as recorded in [ADR 0009](../adr/0009-local-cli-without-payment-recovery.md).

Inspection rejects a different mint found in Coco's mint list or balance map. It reports `wallet.balances.total({ mintUrls: [config.mintUrl], units: ["sat"] }).spendable`, excluding reserved and inflight proofs. Setup persists the configured mint URL without contacting or registering the mint in Coco; capability checks and active mint initialization belong to the server slice. Coco is disposed before the application closes its SQLite connection, including error paths.

The CLI displays the username, configured mint, threshold, next payout index, first payout address and local accumulated balance. Previewing `/0/0` never consumes an index, including after the stored index has advanced. Derivation accepts indices below `2^31`; stored `2^31` is allowed as an exhausted-sequence marker, and a BIP32 child skip is rejected rather than silently changing the requested index. Actual payout allocation remains future work under [ADR 0002](../adr/0002-sequential-payout-addresses-without-history-lookups.md).

CLI summaries omit the Cashu seed and proof secrets. Unexpected library/SQL errors receive a generic message because their details may contain bound secret values. Successful verification reports local state; it does not establish mint readiness or reconciliation of pending payments.

## Delivery and evidence

The baseline is MIT licensed. `bun run build` bundles the CLI into `dist/index.js` and copies committed SQL and migration metadata to `dist/drizzle/`; both must be shipped together. [migrations.ts](../../migrations.ts) resolves migrations relative to the module, so setup and verification work from another working directory.

[Configuration tests](../../tests/config.test.ts) cover public BIP84 addresses, invalid keys and inputs, and idempotent mint URL normalization compatible with Coco. [Setup tests](../../tests/setup.test.ts) use real temporary SQLite files for repeated setup/reopen, seed stability, rollback, invalid stored state, singleton/index constraints, migration coexistence, Coco key derivation, counters and spendable-balance filtering. [CLI tests](../../tests/cli.test.ts) cover help, setup and verify from a separate working directory, process exit and safe output.

At the normalization commit, all 46 tests, typechecking and the build passed. The review also exercised bundled setup and verification with packaged migrations from an isolated directory. These checks make no mint requests or payments and do not establish behavior during power loss or live payment recovery.

Lightning Address endpoints, mint capability checks, receiving payments, payout initiation/recovery, configuration updates, consistent backup/restore, Docker packaging and Fly deployment remain subsequent work. The deployment and suspension decisions in [ADR 0006](../adr/0006-flyio-deployment-target.md) and [ADR 0007](../adr/0007-fly-controlled-suspension.md) remain the agreed target, with runtime verification still outstanding.

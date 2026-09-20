# Sats on Ice

A self-hosted, MIT-licensed Lightning Address service that accumulates payments as Cashu ecash and sweeps them to a Bitcoin wallet when a configured threshold is reached.

The first slice implements local CLI setup and verification. Lightning Address endpoints, mint capability checks, receiving payments, payouts and Fly.io deployment are subsequent slices. See the [v1 design](https://github.com/Egge21M/sats-on-ice/issues/1) and [setup ticket](https://github.com/Egge21M/sats-on-ice/issues/2).

## Set up an instance

Use Bun 1.3.14 (the tested version) and install the pinned dependencies:

```sh
bun install --frozen-lockfile
```

Export a **Bitcoin mainnet native SegWit account xpub or zpub** from a fresh account dedicated to this instance, typically `m/84'/0'/0'`. Supply the account key, not the master key or receiving-branch key. Private keys, testnet keys, descriptors and other address types are unsupported.

```sh
bun run cli --database ./data/sats-on-ice.sqlite setup \
  --username alice \
  --mint https://your-mint.example \
  --xpub YOUR_ACCOUNT_XPUB_OR_ZPUB \
  --threshold 100000
```

Setup displays the first receiving address at `/0/0`, the next payout index (initially zero) and the local accumulated balance (initially zero). **Compare the first address with your wallet before receiving payments.** An xpub does not encode its full origin path or intended address type. No address-history or reuse checks are performed, and previewing the address does not consume an index.

The CLI generates one Cashu seed and persists it together with the configuration, identity and Coco repositories. Repeating setup with equivalent inputs reopens that state. Conflicting inputs are rejected; setup never replaces the seed, destination key, mint or index. Equivalent xpub/zpub encodings are stored as the same canonical xpub.

To reopen the stored setup without supplying those inputs again:

```sh
bun run cli --database ./data/sats-on-ice.sqlite verify
bun run cli --help
bun run cli setup --help
```

The default database path is `./data/sats-on-ice.sqlite`, relative to your working directory. Pass the same explicit path on each invocation. `verify` refuses to create a missing database. Both commands run locally and exit without mint requests, recovery, watchers or payment processors. Their output is a local configuration check, not a declaration that the mint is ready for payments.

Usernames accept 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit. Thresholds must be positive safe-integer whole satoshis. Mint URLs must use HTTP(S), without credentials, query strings or fragments. Use HTTPS for a remote mint. This slice does not provide settings updates; the planned configuration commands will allow username and threshold changes while keeping mint and destination key fixed.

## Persistence

One SQLite file holds the complete instance:

| Owner | Tables | Migration history |
| --- | --- | --- |
| Application / Drizzle | `soi_settings`, `soi_identity`, `soi_wallet_secret` | `soi_migrations` |
| Coco | `coco_cashu_*` wallet tables | `coco_cashu_migrations` |

Application settings use JSON values in a key-value table and are decoded and validated with Zod. The identity is a singleton with a constrained integer next payout index. Seed storage is separate from displayable settings. Initial seed, identity and settings writes share one SQLite transaction; Coco migrations run afterward and can be retried with the persisted seed intact. Sharing the file does not make Coco's asynchronous operations atomic with application changes.

The database contains the **unencrypted Cashu seed and spendable ecash**. New data directories use mode `0700` and the database uses `0600`. Keep it on persistent storage and run one owner instance per database. SQLite uses WAL, so an ordinary copy of an open `.sqlite` file alone is not a complete backup. A consistent backup command is planned in [ticket #6](https://github.com/Egge21M/sats-on-ice/issues/6).

## Development

```sh
bun run typecheck
bun test
bun run build
bun dist/index.js --help
```

The build includes the generated SQL in `dist/drizzle/`; deploy that directory alongside `dist/index.js`. Migration lookup is independent of the shell's working directory.

After changing application tables in `src/storage/schema.ts`, run `bun run db:generate --name=<change>`, review the SQL and include the migration and metadata files in version control. Initialization applies those SQL files before opening Coco. Do not model Coco tables in Drizzle or use schema push against the shared database.

Tests use temporary real SQLite files and public BIP84 fixtures. They exercise setup/reopen, seed stability, rollback, input and stored-value validation, schema constraints, migration coexistence, reserved-balance exclusion, Coco seed derivation and CLI output. They do not contact a mint or make payments.

The CLI uses Coco's explicit `Manager` initialization path: `initializeCoco()` in the pinned version runs operation recovery even when watchers are disabled. The future server will own that active lifecycle. Coco is disposed before the caller-owned SQLite connection is closed.

Domain terminology lives in [CONTEXT.md](CONTEXT.md), with design decisions in [docs/adr](docs/adr/). The project is available under the [MIT license](LICENSE).

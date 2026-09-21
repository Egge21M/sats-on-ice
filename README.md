# Sats on Ice

A self-hosted, MIT-licensed Lightning Address service that accumulates payments as Cashu ecash and sweeps them to a Bitcoin wallet when a configured threshold is reached.

Local setup, verification and Lightning Address receiving are implemented. Incoming payments accumulate as Cashu ecash; automatic on-chain payouts and Fly.io deployment remain subsequent slices. See the [v1 design](https://github.com/Egge21M/sats-on-ice/issues/1) and [receiving design and test evidence](docs/design/lightning-receiving.md).

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

Mint URLs are normalized before storage and comparison, including removal of all trailing slashes. For example, `https://MINT.example:443/cashu///` and `https://mint.example/cashu` identify the same configured mint on repeated setup.

To reopen the stored setup without supplying those inputs again:

```sh
bun run cli --database ./data/sats-on-ice.sqlite verify
bun run cli --help
bun run cli setup --help
```

The default database path is `./data/sats-on-ice.sqlite`, relative to your working directory. Pass the same explicit path on each invocation. `verify` refuses to create a missing database. Both commands run locally and exit without mint requests, recovery, watchers or payment processors. Their output is a local configuration check, not a declaration that the mint is ready for payments.

Usernames accept 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit. Thresholds must be positive safe-integer whole satoshis. Mint URLs must use HTTP(S), without credentials, query strings or fragments. Use HTTPS for a remote mint. This slice does not provide settings updates; the planned configuration commands will allow username and threshold changes while keeping mint and destination key fixed.

## Receive Lightning Address payments

After setup, start the server against the same database:

```sh
bun run cli --database ./data/sats-on-ice.sqlite serve --hostname 127.0.0.1 --port 3000
```

Put an HTTPS reverse proxy in front of this HTTP listener. Preserve the public `Host` header, for example `pay.example`, so the configured username `alice` resolves as `alice@pay.example`. Bind `0.0.0.0` when the proxy reaches the server through a container network. The default bind address is `127.0.0.1`; `--port 0` selects a free port. No public domain is stored and forwarded-host headers are not used.

The server checks fresh mint information for enabled `bolt11` receiving and `onchain` payouts in `sat`, including valid limits for both. An incompatible mint fails the initial start. Temporary connectivity/startup failures leave the HTTP service running but payment endpoints return an LNURL error with HTTP 503; validation retries every five seconds. An incompatible mint discovered on a retry stays unready until restart. CLI output distinguishes these states. Capability readiness does not assert that every pending invoice has been claimed or that the processor remains healthy.

Known limitation accepted for this slice: the fresh startup check does not refresh Coco's separate five-minute mint-information cache. After a mint changes its amount limits, a restart can advertise the new range while invoice creation still rejects newly allowed amounts with HTTP 502 until Coco refreshes its cache. Discovery retains the limits from startup; later mint changes are not automatically reflected there. See the [receiving design](docs/design/lightning-receiving.md#confirmed-implementation-constraints).

The only public routes are `GET /.well-known/lnurlp/alice` and its advertised callback, `GET /lnurlp/alice/callback`. To inspect discovery locally through the expected proxy headers:

```sh
curl -H 'Host: pay.example' http://127.0.0.1:3000/.well-known/lnurlp/alice
```

Once the proxy is configured, enter `alice@pay.example` in a compatible payer wallet, choose an amount within the advertised range, and pay its invoice. The callback accepts integer millisatoshis representing whole sats, rejects fractional sats without rounding, and saves the quote and issuance state before returning the invoice. Each successful callback returns a fresh receiving invoice, including retries for the same amount. The server validates the encoded invoice amount, Bitcoin mainnet network and expiry; the payer remains responsible for full Lightning invoice validation.

Coco watches payments and claims ecash using its persisted operation lifecycle. Claiming can lag payment observation by the subscription polling interval (the pinned library defaults are five seconds for fast polling and twenty seconds for backup polling), network latency and mint request throttling. An unpaid invoice contributes nothing to the balance; a paid invoice contributes only after local ecash issuance. Inspect the locally held balance from another terminal:

```sh
bun run cli --database ./data/sats-on-ice.sqlite verify
```

`verify` does not contact the mint or run a second payment processor. Stop the server with Ctrl-C or SIGTERM; it closes HTTP connections, waits for pending application handlers, and disposes Coco before closing SQLite. In-flight HTTP responses may be interrupted. Reopen with the same `serve` command to reconcile pending receiving operations. **Run only one active server against a database**; this is documented rather than enforced. Automatic payouts, processor-health gating and Fly warm-resume handling are outside this slice. Funds currently remain at the Cashu stage regardless of the configured threshold.

For a repeatable walkthrough without funds or a Lightning node:

```sh
bun test tests/receiving.test.ts
```

This runs a local HTTP mint fixture with real Cashu blind signatures, signed BOLT11 invoices, real SQLite persistence and Alby Lightning Tools 9.0.1 as the representative payer client. It verifies 21-sat receiving and reopening, and a 32-sat invoice paid while stopped and claimed once after restart. HTTPS proxy routing and Lightning settlement are simulated; this does not establish live-network routing or compatibility with every wallet. See the [receiving evidence](docs/design/lightning-receiving.md#verification-and-limits) for details.

## Persistence

One SQLite file holds the complete instance:

| Owner | Tables | Migration history |
| --- | --- | --- |
| Application / Drizzle | `soi_settings`, `soi_identity`, `soi_wallet_secret` | `soi_migrations` |
| Coco | `coco_cashu_*` wallet tables | `coco_cashu_migrations` |

Application settings use JSON values in a key-value table and are decoded and validated with Zod. The identity is a singleton with a constrained integer next payout index. Seed storage is separate from displayable settings. Initial seed, identity and settings writes share one SQLite transaction; Coco migrations run afterward and can be retried with the persisted seed intact. Sharing the file does not make Coco's asynchronous operations atomic with application changes.

The database contains the **unencrypted Cashu seed and spendable ecash**. New data directories use mode `0700`; the database and any existing WAL/SHM files are tightened to `0600` before opening. Keep it on persistent storage and run one owner instance per database. SQLite uses WAL, so an ordinary copy of an open `.sqlite` file alone is not a complete backup. A consistent backup command is planned in [ticket #6](https://github.com/Egge21M/sats-on-ice/issues/6).

## Development

```sh
bun run typecheck
bun test
bun run build
bun dist/index.js --help
```

The build includes the generated SQL in `dist/drizzle/`; deploy that directory alongside `dist/index.js`. Migration lookup is independent of the shell's working directory.

After changing application tables in `src/storage/schema.ts`, run `bun run db:generate --name=<change>`, review the SQL and include the migration and metadata files in version control. Initialization applies those SQL files before opening Coco. Do not model Coco tables in Drizzle or use schema push against the shared database.

Tests use temporary real SQLite files and public BIP84 fixtures. They exercise setup/reopen, seed stability, rollback, input and stored-value validation, schema constraints, migration coexistence, reserved-balance exclusion, Coco seed derivation and CLI output. Receiving tests additionally bind loopback HTTP servers for their controlled mint and exercise payment processing without external mint access or real funds.

Local `setup` and `verify` use Coco's explicit `Manager` initialization path: `initializeCoco()` in the pinned version runs operation recovery even when watchers are disabled. `serve` explicitly initializes the configured mint, receiving watcher/processor and mint-operation recovery. Coco is disposed before the caller-owned SQLite connection is closed.

The [local setup design](docs/design/local-setup.md) records the selected dependency versions, validation and persistence boundaries, wallet lifecycle and verification limits. Domain terminology lives in [CONTEXT.md](CONTEXT.md), with design decisions in [docs/adr](docs/adr/). The project is available under the [MIT license](LICENSE).

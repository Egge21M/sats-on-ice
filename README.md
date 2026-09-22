# Sats on Ice

A self-hosted, MIT-licensed Lightning Address service that accumulates payments as Cashu ecash and sweeps them to a Bitcoin wallet when a configured threshold is reached.

Local setup, verification, Lightning Address receiving and automatic on-chain payouts are implemented. Fly.io deployment and warm-resume handling remain subsequent slices. See the [v1 design](https://github.com/Egge21M/sats-on-ice/issues/1), [receiving evidence](docs/design/lightning-receiving.md) and [payout evidence](docs/design/threshold-payouts.md).

## Configure and start an instance

Use Bun 1.3.14 (the tested version) and install pinned dependencies with `bun install --frozen-lockfile`. Configure the environment using [.env.example](.env.example) as a reference:

```sh
export SOI_MINT_URL=https://your-mint.example
export SOI_PAYOUT_THRESHOLD_SATS=100000
export SOI_USERNAME=alice
export SOI_XPUB=YOUR_ACCOUNT_XPUB_OR_ZPUB
export SOI_DATABASE=./data/sats-on-ice.sqlite
bun run cli serve
```

The server initializes a fresh database and Cashu seed automatically; no prior `setup` command is required. Mint URL and threshold are required environment values on every invocation and are not stored as application settings. On a fresh database, username and xpub are also required. On later starts, omit either to reuse that value from the last active identity. Valid changed values select or create the corresponding identity without deleting old records or replacing the Cashu seed.

Supply a **Bitcoin mainnet native SegWit account xpub or zpub** from a fresh account dedicated to this instance, typically `m/84'/0'/0'`. Private keys, testnet keys, descriptors and other address types are unsupported. For an offline address preview before starting to receive payments:

```sh
bun run cli setup    # Optional: initialize/select the env-configured identity and print a preview
bun run cli verify   # Inspect an existing identity and the selected mint's local balance
```

**Compare the first payout address with your wallet before receiving payments.** The `/0/0` preview consumes no index; xpubs do not establish the account's full origin path, and address history/reuse is not checked. Equivalent xpub/zpub encodings share one normalized destination and counter.

Changing the username preserves the counter for the same destination. Changing the xpub selects a separate counter. Switching back resumes the previous destination's counter and reuses its identity. Only one identity's username is served at a time. `verify` does not create or activate identities, contact a mint, or run recovery; its balance is locally recorded spendable sats at `SOI_MINT_URL`.

Changing `SOI_MINT_URL` selects the mint for new invoices and payout attempts. Remaining ecash at earlier mints stays in Coco, without automatic migration or new sweeps at those mints; Coco may recover existing operations. An already-submitted payout retains its recorded destination. A threshold change takes effect on restart.

`SOI_DATABASE` defaults to `./data/sats-on-ice.sqlite`, `SOI_HOSTNAME` to `127.0.0.1`, and `SOI_PORT` to `3000`. CLI flags `--database`, `--hostname` and `--port` override those process settings. Username/xpub/mint/threshold are configured through the environment, not setup flags. Usernames accept 1–64 lowercase letters, digits, dots, underscores or hyphens and begin with a letter; thresholds must be positive whole sats within JavaScript's safe-integer range. Use HTTPS for remote mints.

**Existing databases:** the migration preserves the seed, Coco state, identity and next payout index while splitting destinations into their own table. It removes the old settings table. Supply `SOI_MINT_URL` and `SOI_PAYOUT_THRESHOLD_SATS` before upgrading; the old database values are no longer runtime defaults. Username and xpub can be omitted to retain the migrated active identity.

## Receive Lightning Address payments

With the environment configured, start the server against the persistent database:

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

`verify` does not contact the mint or run a second payment processor. Stop the server with Ctrl-C or SIGTERM; it closes HTTP connections, waits for pending application handlers, and disposes Coco before closing SQLite. In-flight HTTP responses may be interrupted. Reopen with the same `serve` command to reconcile pending receiving operations. **Run only one active server against a database**; this is documented rather than enforced. The server now automatically sweeps eligible spendable funds through the mint’s on-chain method. Processor-health gating and Fly warm-resume handling remain later work.

For a repeatable walkthrough without funds or a Lightning node:

```sh
bun test tests/receiving.test.ts
```

This runs a local HTTP mint fixture with real Cashu blind signatures, signed BOLT11 invoices, real SQLite persistence and Alby Lightning Tools 9.0.1 as the representative payer client. It verifies 21-sat receiving and reopening, and a 32-sat invoice paid while stopped and claimed once after restart. HTTPS proxy routing and Lightning settlement are simulated; this does not establish live-network routing or compatibility with every wallet. See the [receiving evidence](docs/design/lightning-receiving.md#verification-and-limits) for details.

## Automatic payouts

At startup and after an ecash claim or payout settlement, the server evaluates the environment-configured threshold against spendable sats, excluding reserved proofs. At or above the threshold it allocates the next `/0/index` address, commits the incremented index, and requests an on-chain sweep quote. Failed attempts can leave unused addresses; an allocated index is never rolled back.

The sweep uses the available balance, deducts input fees and the lowest advertised fee reserve, and includes any required pre-swap costs. Fee options are selected by their advertised identifier. There is no separate application fee cap. Returned change and proof-selection remainders stay in the accumulated balance. Unsupported, out-of-range or unaffordable quotes are reported without a fallback payment route.

The `serve` output includes the payout address, allocated index, recipient amount, selected reserve, Coco operation ID and subsequent pending/finalized state. A mint-reported outpoint does not establish Bitcoin confirmation. Coco owns preparation, reserved proofs, execution and settlement. New receipts may trigger a separate payout while another remains pending; initiation is serialized within the one server process. `verify` remains offline and reports spendable balance and next index; richer management remains future work.

A failed attempt is not retried continuously against the same proofs. A new receipt, settlement or restart can reevaluate the balance; the application never replays a possibly submitted withdrawal. Coco recovery can leave prepared operations reserved for an owner decision, and may retain unresolved operations after connectivity failures. This slice adds no recovery CLI. Keep the complete database and inspect persisted operations before taking recovery action.

Run the controlled receiving-to-payout walkthrough with:

```sh
bun test tests/payouts.test.ts
```

It uses real Coco operations and Cashu proof verification, with simulated Bitcoin settlement and no real funds. See [payout design and evidence](docs/design/threshold-payouts.md). Fly suspension may defer all processing until a later request or explicit wake; warm-resume verification remains issue #8.

## Persistence

One SQLite file holds the durable instance state; retain the runtime environment separately:

| Owner | Tables | Migration history |
| --- | --- | --- |
| Application / Drizzle | `soi_destination`, `soi_identity`, `soi_active_identity`, `soi_wallet_secret` | `soi_migrations` |
| Coco | `coco_cashu_*` wallet tables | `coco_cashu_migrations` |

Each identity references a destination, and each normalized xpub owns one next payout index shared across its identities. A singleton active reference supplies fallback identity values. Seed storage is separate. Initial seed creation and identity selection share an immediate transaction; Coco migrations run afterward and can be retried with the persisted seed intact. Application and Coco migration histories remain separate.

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

Local `setup` and `verify` read Coco repositories without creating a manager. `serve` creates one manager with `initializeCoco()` and its default watchers, processors and recovery; application payout reactions use `Manager.on`. Returned managers are disposed before SQLite closes; see the [receiving lifecycle](docs/design/lightning-receiving.md#implementation) for the factory failure-cleanup limitation.

The [local setup design](docs/design/local-setup.md) records the selected dependency versions, validation and persistence boundaries, wallet lifecycle and verification limits. Domain terminology lives in [CONTEXT.md](CONTEXT.md), with design decisions in [docs/adr](docs/adr/). The project is available under the [MIT license](LICENSE).

# Deploy one persistent server on Fly.io

The production image runs one `serve` process against `/data/sats-on-ice.sqlite` on one Fly Volume. `serve` creates the wallet and applies both migration histories at startup. The build only bundles code and copies committed migrations; it creates no wallet. Do not add a `release_command`: Fly release Machines have no persistent volumes. [Fly configuration](https://fly.io/docs/reference/configuration/).

This intentionally accepts downtime during restart, deployment or host failure. Do not scale out, clone the wallet into another running Machine, or add an independent volume as a replica. A Fly Volume is local to one host and Fly does not replicate its contents. Retain [complete off-host backups](wallet-backup.md) and runtime configuration separately; volume snapshots are additional coverage. [Volume behavior](https://fly.io/docs/volumes/overview/).

## Image and local container check

The Dockerfile pins Bun 1.3.14 by multi-platform image digest, installs `bun.lock` with `--frozen-lockfile`, and copies only the bundled application, migrations and license into the final image. `.dockerignore` allows only build inputs, excluding local environment files, databases, backups and Git history. The image runs as root to use Fly's root-owned mounted volume; run inspection as the same user. Wallet and existing sidecar permissions are restricted to `0600`, and the local status socket directory to `0700`. No wallet or runtime policy belongs in an image layer.

```sh
docker build -t sats-on-ice:local .
docker volume create soi_data
docker run --rm --mount source=soi_data,target=/data \
  --env-file .env sats-on-ice:local setup
docker run --rm --mount source=soi_data,target=/data \
  --env-file .env sats-on-ice:local verify
docker run --name sats-on-ice --mount source=soi_data,target=/data \
  --env-file .env -p 127.0.0.1:3000:3000 sats-on-ice:local
```

For this example, omit `SOI_DATABASE`, `SOI_HOSTNAME` and `SOI_PORT` from `.env` to use the image defaults. `setup` is optional and performs no payment recovery. Compare its `/0/0` preview with the receiving address of your fresh dedicated mainnet native SegWit account before receiving funds. Stop the server before running another server against this volume. `docker stop --time 30 sats-on-ice` sends SIGTERM to Bun directly and allows shutdown to finish.

## First Fly deployment

Copy the template so owner configuration stays out of commits:

```sh
cp fly.toml fly.local.toml
```

Edit `app` to a globally unique name and choose `primary_region`. Use that same region when creating the volume. Under `[env]`, set:

```toml
SOI_MINT_URL = "https://YOUR-COMPATIBLE-MINT"
SOI_PAYOUT_THRESHOLD_SATS = "100000"
SOI_USERNAME = "alice"
SOI_XPUB = "YOUR-MAINNET-NATIVE-SEGWIT-ACCOUNT-XPUB-OR-ZPUB"
```

Use real owner values only for a real instance. The controlled walkthrough below uses the public BIP84 fixture account and simulated payments. The selected mint must support `bolt11` receiving and `onchain` payouts in sats. The username/xpub are required for a fresh database; mint and threshold are required on every startup and local inspection invocation.

An xpub reveals the destination account's addresses. If you prefer not to put it in the local TOML file, stage it with `fly secrets set --app "$SOI_APP" --stage SOI_XPUB="$SOI_XPUB"`. Secrets become runtime environment values and override `[env]`; retain them separately for recovery. [Fly secrets](https://fly.io/docs/apps/secrets/).

Run from the repository root, replacing the example values:

```sh
export SOI_APP=your-unique-app
export SOI_ORG=personal
export SOI_REGION=fra
fly apps create "$SOI_APP" --org "$SOI_ORG"
fly volumes create soi_data --app "$SOI_APP" --region "$SOI_REGION" --size 1 --count 1
fly config validate --config fly.local.toml --strict
fly deploy --config fly.local.toml --ha=false --remote-only
fly machines list --app "$SOI_APP"
fly volumes list --app "$SOI_APP"
fly checks list --app "$SOI_APP"
```

Confirm exactly **one wallet Machine and one attached `soi_data` volume**. Record their IDs. `--ha=false` expresses this intent on the first deployment; it does not reduce an already scaled app to one Machine. Do not use an existing app with other Machines for this procedure. [Machine scaling](https://fly.io/docs/launch/scale-count/).

The defaults use one shared CPU and 512 MB RAM. The app's `0.0.0.0:3000` listener matches Fly's internal port; the proxy supplies public HTTPS and preserves Host. No fixed domain is stored. Fly's `.fly.dev` hostname works for the initial Lightning Address; custom domains require DNS and certificates. [Custom domains](https://fly.io/docs/networking/custom-domain/).

```sh
export SOI_MACHINE=the-wallet-machine-id
fly ssh console --app "$SOI_APP" --machine "$SOI_MACHINE" \
  -C 'bun /app/dist/index.js verify'
fly ssh console --app "$SOI_APP" --machine "$SOI_MACHINE" \
  -C 'bun /app/dist/index.js status'
curl --fail-with-body "https://$SOI_APP.fly.dev/readyz"
curl --fail-with-body "https://$SOI_APP.fly.dev/.well-known/lnurlp/alice"
```

Compare the first address printed by `verify` with your wallet **before paying any invoice**. This command uses the mounted database and starts no payment manager. Optional `setup` uses the same CLI path and environment for offline initialization/identity selection; it is unnecessary for `serve` bootstrap and is not a live reconfiguration mechanism. Configure identities through the deployment environment and restart the server. Neither `setup` nor `verify` establishes payment readiness.

Discovery must return an HTTPS callback on the same public host. Use `alice@<app>.fly.dev` in a compatible payer wallet. `GET /lnurlp/alice/callback?amount=21000` creates a 21-sat receiving invoice; it does not pay it. In a real deployment the payer sends Lightning to the mint, and the application later claims ecash.

## Readiness, failures and suspension

Fly checks `GET /readyz` every 30 seconds after a 30-second startup grace period. It returns only `{ "ready": true }` with HTTP 200 once the existing startup capability check and Coco initialization succeed, otherwise `{ "ready": false }` with HTTP 503. The route has no identity, balances, seed or diagnostics, makes no mint request and creates no invoice. All other methods return 405. Local `status` and `fly logs --app "$SOI_APP"` provide the more detailed safe diagnostic messages.

Readiness is the server's recorded startup state. It **does not prove fresh balance reconciliation, current connectivity or processor health**. Warm-resume readiness and missed payment events are issue #8. Coco 2.0.0 can leave workers behind if its factory throws after starting them without returning a manager; retries after such failures may require a process restart. Returned managers are disposed on shutdown.

| Failure | What to do |
| --- | --- |
| `Invalid configuration` naming `SOI_MINT_URL`, threshold, username or xpub | Correct `[env]` or staged secrets and redeploy. Thresholds are positive whole sats; destination keys must be supported mainnet account xpub/zpub values. |
| Fresh database missing username/xpub | Supply both. On an existing volume, check the mount/path before assuming the wallet is new. |
| Database/permissions/migrations failure | Inspect mount, path, disk space and image migrations. Preserve the database; never delete it to make startup pass. |
| Temporary mint/startup failure | The service stays unready and retries every five seconds. Inspect logs and mint connectivity. |
| Incompatible mint | Correct mint configuration and restart. No payment readiness is granted. |
| Fly health check fails | Check the logs, port/bind settings and `/readyz`. Do not bypass readiness to accept invoices. |

Fly controls idle suspension with `auto_stop_machines = "suspend"`, `auto_start_machines = true` and `min_machines_running = 0`. Health checks run over the private network; they are not a separate wake scheduler. There is no application busy veto or suspend call. Mint connections and pending work do not keep the Machine awake. Paying an invoice at the mint does not wake this app; claims and payouts can wait for an incoming request or explicit wake. Memory-preserving resume need not rerun initialization, and Fly can instead cold-start after maintenance or deployment. [Fly autostop](https://fly.io/docs/reference/fly-proxy-autostop-autostart/), [suspend/resume](https://fly.io/docs/reference/suspend-resume/).

## Restart, redeploy and change configuration

Record `status`, take a complete backup, and retain runtime configuration before changing an existing wallet. Remove `SOI_USERNAME` and `SOI_XPUB` from `[env]` to test reuse of the last active identity. If either was stored as a secret, also stage its removal with `fly secrets unset --app "$SOI_APP" --stage SOI_USERNAME SOI_XPUB` (name only secrets that exist). Empty strings are invalid overrides, not omission.

```sh
fly deploy --config fly.local.toml --ha=false --remote-only
fly machine restart "$SOI_MACHINE" --app "$SOI_APP" --signal SIGTERM --time 30
fly ssh console --app "$SOI_APP" --machine "$SOI_MACHINE" \
  -C 'bun /app/dist/index.js status'
```

Confirm the same mounted volume, active identity, destination counter, balances and operation history. Redeploying replaces image/root filesystem content while retaining `/data`. Keep exactly one server and the same volume. Recheck Machine/volume IDs after each deployment; do not assume IDs can never change.

To change username, destination, mint or threshold, edit the environment and redeploy. A username change with the same normalized xpub shares its counter; switching destinations gives each key its own counter, and switching back resumes the earlier counter. The Cashu seed and identity history remain. Earlier-mint funds remain in Coco without automatic migration or new sweeps; existing operations may recover at their recorded destinations. A running server keeps its captured configuration until restart. Updating an xpub requires comparing that destination's first address before new receipts.

## Controlled deployment walkthrough

Use disposable apps and a fresh volume, never an existing wallet. `scripts/fly-smoke-mint.ts` wraps the existing cryptographic mint fixture with a token-protected payment simulator. It has no Lightning node or Bitcoin backend. Keep this mint running unchanged while restarting/redeploying the wallet: its test state is in memory. Do not put it into the production app image.

Bundle it into a separate temporary build directory:

```sh
export SOI_FIXTURE_DIR=$(mktemp -d)
bun build scripts/fly-smoke-mint.ts --target=bun --outfile "$SOI_FIXTURE_DIR/mint.js"
cat > "$SOI_FIXTURE_DIR/Dockerfile" <<'EOF'
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
WORKDIR /app
COPY mint.js ./mint.js
CMD ["bun", "/app/mint.js"]
EOF
```

Create a separate disposable fixture app, keeping its autostop **off** for the duration of the check:

```sh
export SOI_MINT_APP=your-unique-test-mint
export SOI_SMOKE_TOKEN=$(openssl rand -hex 32)
cat > "$SOI_FIXTURE_DIR/fly.toml" <<EOF
app = "$SOI_MINT_APP"
primary_region = "fra"
kill_signal = "SIGTERM"
[http_service]
internal_port = 3000
force_https = true
auto_stop_machines = "off"
auto_start_machines = true
min_machines_running = 1
[[vm]]
cpu_kind = "shared"
cpus = 1
memory = "512mb"
EOF
fly apps create "$SOI_MINT_APP" --org "$SOI_ORG"
fly secrets set --app "$SOI_MINT_APP" --stage SOI_SMOKE_TOKEN="$SOI_SMOKE_TOKEN"
fly deploy "$SOI_FIXTURE_DIR" --config "$SOI_FIXTURE_DIR/fly.toml" --ha=false --remote-only
```

The control endpoints require `Authorization: Bearer <token>`; public mint endpoints expose only simulated state. Then deploy the unchanged production Dockerfile and Fly template against `https://<fixture-app>.fly.dev`, username `alice`, the public `ZPUB` in `tests/fixtures.ts`, and threshold `1000`. These public test keys must never receive real payments. Keep the wallet's `fly.local.toml` in the repository root so its relative Dockerfile path resolves correctly.

1. Verify the fresh volume initializes without `setup`, `/readyz` returns 200, Fly checks pass, and public discovery advertises its own HTTPS callback. On-volume `verify` must print `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu` and next index 0.
2. Request a 1000-sat invoice through that public callback, then POST `{ "invoice": "<pr>" }` to the fixture's `/__test/pay` with the control token. This simulates payment. Request discovery again if needed to wake the wallet. Inspect `status` until the receipt is claimed and a simulated payout finalizes at `/0/0`, index 1. The fixture's authenticated `/__test/state` must show issuance count 1 and melt count 1. Its `payouts` array includes unsubmitted fee-probe quotes; count submissions using `meltRequests` and inspect the `PAID` quote's destination. With the fixture's default 10-sat reserve and 3-sat refund, 3 sats remain locally.
3. Request/pay another 21 sats. Expect 24 locally held sats, issuance count 2, melt count 1, index 1. Take a consistent backup; keep it private. Compare a local hash of the stored seed across later snapshots without printing the seed.
4. Omit both identity environment values, redeploy the production image and restart the Machine. Verify the same seed hash, identities, destinations/counter, active reference, both migration histories, Coco keyset counters, mint operations, proofs and payout record. Verify `alice` remains active, balance 24 and next index 1; no duplicate issuance or payout. Image redeploy must retain the same volume.
5. Change only username to `bob`, redeploy, and verify the prior receiving URL returns 404, the new callback uses `bob`, both identities remain in SQLite and the destination's next index remains 1. Receive/pay 1000 simulated sats; the next payout must use `bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g` (`/0/1`) and leave next index 2. Switch back to `alice` and verify its original identity is reused with index 2 and the same seed.
6. Export a final backup, record the evidence without seed/proof secrets, and destroy **only these disposable test apps and volumes**. Do not retain a fixture wallet for real use. Remove the temporary fixture build directory and token.

This exercises the production image, public TLS/Host behavior, automatic bootstrap, local CLI and persistent state through cold restart and image deployment. It does not demonstrate Lightning routing, Bitcoin broadcast/confirmation, or warm-resume payment correctness. Issue #8 owns the latter, including payment while suspended, stale connections, and interruption during payout submission.

## Verification record

Controlled run on 2026-09-22 with flyctl 0.4.102, Bun 1.3.14 and Coco 2.0.0: wallet app `soi-check-1cbca5`, auxiliary simulated mint `soi-mint-1cbca5`, region `fra`. The wallet had exactly one 512 MB shared-CPU Machine (`286d923cd960e8`) and one encrypted 1 GB volume (`vol_vly1oj0zy536x184`). These are disposable evidence identifiers, not production endpoints.

| Check | Observed result |
| --- | --- |
| Production Docker build through Fly's remote builder | Frozen installation and bundled migrations succeeded; final image reported 58 MB. No wallet initialization at build/release time. |
| Fresh attached volume | Automatic `serve` bootstrap; expected `/0/0` preview, zero balance and index 0. No `setup` invocation. |
| Public networking and readiness | HTTP redirected to HTTPS (301); discovery callback preserved the public `.fly.dev` host. `/readyz` and Fly's configured health check passed. |
| 1000-sat simulated receipt | One claim, one finalized 990-sat payout to `/0/0`; next index 1 and 3 sats remaining. |
| Additional 21-sat simulated receipt | Two total claims, still one payout; balance 24 and index 1. |
| Image redeploy, identity variables omitted | `alice` reused. Row digests of **all 23 database tables** matched a pre-deployment backup, including the seed, both migration histories, identities, destination counter and Coco state. |
| Separate SIGTERM cold restart | All 23 table digests still matched; no duplicate issuance or payout. Same Machine and volume. |
| Environment username changed to `bob` | Old discovery URL returned 404; new public callback used `bob`; balance 24 and shared index 1 were retained. |
| 1000-sat receipt as `bob` | Third total claim, second total withdrawal, now to `/0/1`; 3 sats remaining and next index 2. |
| Switched back to `alice` | Original identity 1 reused, both identities retained, same seed, shared counter 2 and no additional claim or payout. |
| Final image inspection | `/app` contained only `dist` and `LICENSE`; no source tree, test fixture, dependencies directory or wallet state. |

Local validation passed: 104 tests / 540 assertions, typecheck, build, and strict Fly configuration validation. Readiness tests cover ready/unready responses, recovery from temporary mint failure and no mint work from health checks. The first full run hit the previously observed intermittent CLI status failure (`no local status response`); that test passed in isolation and the subsequent full suite passed. A deployed CLI inspection also intermittently reported live status unavailable while its local wallet snapshot and public readiness were available; a fresh-volume inspection successfully read the running server configuration. This is an existing observation limit, not evidence of fresh processor health.

Both disposable apps and their test volume were destroyed after verification; no deployment from this run remains. No real Lightning payment or Bitcoin broadcast occurred. Warm-resume payment reconciliation remains unverified here and belongs to #8.

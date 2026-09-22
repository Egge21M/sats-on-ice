# Payment recovery after restart and suspension

The active `serve` process owns payment reconciliation. On cold start it initializes Coco, refreshes pending mint quotes and in-flight receiving/payout operations through Coco's public APIs, and then evaluates the selected mint's payout threshold. A successful `initializeCoco()` alone is insufficient: Coco 2.0.0 catches individual recovery failures and can return a manager with unresolved work.

A memory-preserving Fly resume does not rerun startup. The server therefore observes gaps between event-loop ticks using both wall time and monotonic time. A gap greater than five seconds, or a backwards wall-clock change, makes receiving and new payout initiation unready while the same manager reconciles. The awake-only timer checks once per second; HTTP requests, live CLI snapshots and payout initiation also check before reporting readiness or spending. A pause during reconciliation invalidates that pass. This is a conservative pause detector, not a Fly lifecycle notification: long event-loop stalls also trigger it, while pauses shorter than five seconds rely on Coco's normal workers. Readiness is an observation, not a continuously verified balance.

No application timer wakes a suspended Machine. There is no suspend call, busy veto, external wake service or promise of background progress while asleep. Fly may suspend with outstanding invoices or payouts. A payment at the mint does not wake the wallet; another incoming HTTP request or an explicit owner wake is needed. Fly can also cold-start instead of restoring memory. See [Fly suspend/resume](https://fly.io/docs/reference/suspend-resume/) and [automatic stop/start](https://fly.io/docs/reference/fly-proxy-autostop-autostart/).

## Coco remains responsible for payments

The integration retains `initializeCoco`'s default watchers and processors and its `Manager.on` payment events. Coco's hybrid transport includes backup polling, which recovered in tests when a WebSocket closed and when an apparently open socket delivered no notifications. No transport replacement or repeated manager initialization was necessary for these cases.

Reconciliation uses `quotes.mint.listPending/refresh`, `ops.mint.listInFlight/refresh` and `ops.melt.listInFlight/refresh`. A paid quote awaiting automatic claim keeps the service unready, including a quote persisted before any operation was prepared. New sweeps are gated before index allocation and again before execution. Only a definitely unsubmitted prepared operation may be cancelled at that second gate; its index remains consumed. Once execution starts, the application never replays or reclaims that withdrawal. Coco owns locks, proof restoration, pending settlement and terminal transitions. See [mint operations](https://cashubtc.github.io/coco/pages/mint-operations.html), [melt operations](https://cashubtc.github.io/coco/pages/melt-operations.html) and [subscriptions](https://cashubtc.github.io/coco/starting/subscriptions.html); the pinned 2.0.0 source is the implementation baseline.

Unpaid invoices and remotely confirmed pending payouts are legitimate reconciled states. A reconciliation pass need not wait for someone to pay every invoice or for every withdrawal to settle. Available proofs at the running server's selected mint determine new sweeps; earlier-mint funds remain separate. Existing operations at earlier mints are checked too, so an unavailable earlier mint can delay readiness. Submitted payouts retain their stored destinations across configuration changes, and new payouts consume the selected destination's shared index.

Prepared operations left by a crash, failed operations and records requiring manual recovery remain visible through status; this work does not automatically execute, cancel or repair them. Reconciliation is not a proof-by-proof audit of every historical balance or a resolution of every historical error. Coco 2.0.0 can also leave workers behind if `initializeCoco()` throws after starting them without returning a manager. The application cannot dispose that missing manager; a process restart may be needed. Returned managers are reused across reconciliation retries and disposed on shutdown.

## Readiness and local inspection

`GET /readyz` returns 503 during validation or reconciliation, and 200 only after a successful pass. Payment routes likewise refuse new invoices while unready. Transient reconciliation failures retry every five seconds with a safe diagnostic; incompatible mint capabilities require correction and restart. In ordinary operation the readiness route reports recorded state without probing the mint. Its first request after a detected pause can initiate reconciliation.

`status` displays the server's readiness, observation times and last successful payment reconciliation. Its SQLite balance is always labelled a local snapshot, not freshly reconciled by that command. Offline `status`, `setup`, `verify` and backup never create another manager or start recovery. A live status request can cause the already-running server to notice a pause, just like its timer or an HTTP request. Missing socket response means live readiness is unavailable, not that the process is necessarily stopped.

The local socket protocol waits for a client byte before sending its snapshot. This fixes a Bun 1.3.14 cross-process race in which immediate server send-and-close produced `ECONNREFUSED` in the client despite a successful OS connect. A minimal reproducer failed 24 of 30 reads before the handshake and 0 of 30 afterward; the committed regression test uses twelve separate CLI processes.

## Repeatable integration checks

Run `bun test tests/resume.test.ts tests/live-status.test.ts tests/payouts.test.ts`. These checks use public HTTP routes, read-only status and a cryptographic mint fixture; no manager internals are mocked.

- Cold start with failed quote checks remains unready and consumes no index; restored connectivity leads to one claim and one sweep.
- A paid quote with no prepared operation stays unready until Coco's default processor claims it.
- A child server is actually frozen with `SIGSTOP`, paid while asleep, and resumed with `SIGCONT`. Both closed and silent WebSockets recover once, then handle a second receipt through polling. Failed quote checks keep HTTP and CLI unready; process start time stays unchanged and the reconciliation time advances.
- The mint accepts a withdrawal while withholding its HTTP response. Suspending or killing the child at this boundary, settling remotely, and resuming/restarting produces one recovered payout, the original destination and the consumed index. A subsequent payout uses the next index, including after a username change. Every withdrawal POST is counted, so a rejected duplicate submission would fail the test.
- Existing payout tests retain coverage for changed mint and destination: earlier funds are not swept, submitted payouts recover to their recorded destination, and new payouts use the newly selected key.

The WebSocket fixture bounds shutdown after closing its listener and all actual sockets: Bun 1.3.14 can retain a phantom WebSocket count after a server-initiated close, leaving its `stop()` promise unresolved. The harness still fails if actual requests or sockets remain. This workaround is confined to the test fixture.

## Controlled Fly check

Use the disposable mint and wallet setup in the [deployment guide](fly-deployment.md#controlled-deployment-walkthrough), with the unchanged production Dockerfile and Fly suspension settings. Never use real funds. The auxiliary fixture must remain running because its state is in memory.

1. Record wallet CLI status and process start time; issue a 1000-sat invoice but do not pay it. Stop traffic to the wallet, including status/SSH and public health polling. Observe only `fly machines list --app "$SOI_APP" --json` until Fly reports `suspended`; do not call `fly machine suspend`.
2. Pay the saved invoice using the fixture's authenticated `POST /__test/pay`. Confirm fixture issuance/melt counts remain zero and Fly still reports the wallet suspended. This proves remote payment alone did not wake it.
3. Send a later request to the public discovery route. It may initially return 503 while reconciliation runs. Once ready, inspect status: same process start time establishes warm resume; one issuance and one withdrawal establish exactly-once recovery for this scenario. Expect index 1, payout to `/0/0` and 3 sats of returned fees.
4. Set `POST /__test/pending-payouts` to `{ "enabled": true }`, then issue/pay another 1000 sats. Wait for the recorded payout to become pending at `/0/1`, index 2, and let Fly automatically suspend again.
5. Call authenticated `POST /__test/settle` at the fixture while the wallet remains suspended. Confirm it remains asleep, then wake via public discovery. Coco should finalize the existing payout with two total submissions, index 2 and the same process start time. No application replay occurs.
6. Record the safe evidence and destroy the disposable wallet and mint apps (including the test volume). Delete temporary control tokens and fixtures. No test deployment should remain for real use.

All control endpoints require `Authorization: Bearer <SOI_SMOKE_TOKEN>`. `/__test/state` reports counts and public payout addresses; fee-probe quotes are not submissions. `/__test/settle` settles all submitted pending fixture payouts. These endpoints are only in the separate test image.

## Verification record

Controlled run on 2026-09-22 using Bun 1.3.14, Coco 2.0.0 and flyctl 0.4.102, region `fra`. Wallet `soi-resume-f4bf78` used one 512 MB shared-CPU Machine (`2862d72c505d38`) and one encrypted 1 GB volume (`vol_vdelkg72qg3d0ew4`); the separate simulated mint was `soi-mint-f4bf78`. Production image digest: `sha256:661ee81291bd20802abe2d7d7ed2d1f989892ff6d1cf7ca0d055b3a99cf32021`. These are disposable evidence identifiers, not production endpoints.

| Check | Observed result (UTC) |
| --- | --- |
| Outstanding invoice and automatic suspension | Issued 1000 sats at 13:54:01. Fly proxy logged **autosuspending** at 13:58:50 and suspended at 13:58:51. No manual suspend call or application veto. |
| Payment while asleep | Paid only the simulated mint at 13:59:24. Mint counts remained zero claims / zero submissions at 13:59:27; Machines API still reported the wallet suspended. |
| Incoming-request warm wake | Public discovery request resumed the Machine. Server logged pause detection at 13:59:49, stayed unready through a reconciliation retry, then became ready at 13:59:55. Discovery returned 200 at 13:59:56. |
| Exactly-once receipt and payout | One issuance and one 990-sat withdrawal to `/0/0` (`bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`); index 1, 3 sats spendable, no reserved payout funds. |
| Memory-preserving resume | CLI before and after wake reported the identical server start time `2026-09-22T13:53:34.186Z`; last reconciliation advanced from 13:53:34.490 to 13:59:55.007. |
| Pending payout survives automatic suspension | Second 1000-sat receipt produced a pending 993-sat withdrawal to `/0/1` (`bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g`), 1003 sats reserved and next index 2. Fly autosuspended at 14:05:01, suspended at 14:05:03. |
| Settlement while asleep, then warm recovery | Mint settled at 14:05:50; Machines API still reported suspended. Incoming discovery returned 200 at 14:05:58 after reconciliation. Same process start time, two total claims / two submissions, both payouts finalized, index 2, 3 sats spendable and zero reserved. |

Local validation: the full suite passed 111 tests / 620 assertions, followed by strengthened withdrawal-attempt checks (2 tests / 25 assertions). Typecheck and production build passed. No real Lightning payment, Bitcoin broadcast or confirmation is represented by this simulated mint. Live mint interoperability remains separate work.

Both disposable apps and the wallet volume were destroyed after verification; the app list confirmed neither remained. Temporary control tokens, fixture builds and deployment configuration were removed.

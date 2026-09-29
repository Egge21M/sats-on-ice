# Payment recovery after restart

Sats on Ice supports a continuously running server or a full shutdown followed by a new process. Retain the complete SQLite database and runtime configuration between starts. Memory-preserving suspension and warm resume are unsupported; stop `serve` before putting its host to sleep and start a new process afterward. See [ADR 0007](../adr/0007-shutdown-and-startup.md).

## Coco owns recovery

`serve` opens the saved database and seed, validates the configured mint's capabilities, and calls `initializeCoco()` with its default watchers and processors. Coco automatically checks saved receiving and payout operations during initialization and monitors pending quotes through its workers. The application does not repeat those checks, wait for all paid invoices to be claimed, or maintain a separate reconciliation state or timestamp.

After Coco initializes and the selected mint is registered, the application subscribes to payment events, evaluates available funds once and makes receiving ready. Claims and payout settlement trigger later evaluations through `Manager.on`. Coco's available-proof repository excludes reserved and inflight proofs, so unresolved operations do not make their reserved inputs available for another payout. Submitted payouts retain their recorded destination across configuration changes. New sweeps use the selected mint and destination's shared index; earlier-mint funds are not automatically swept or moved.

The application never replays or reclaims a possibly submitted withdrawal. Coco owns proof restoration, locks, pending settlement and terminal transitions. Prepared operations left by a crash and failures requiring owner decisions remain visible through status. Successful wallet initialization is not a proof-by-proof audit or a promise that every operation has recovered.

## Readiness and failures

`GET /readyz` returns 503 until capability validation and wallet initialization succeed, then returns 200. Payment routes follow that readiness state. A temporary failure of the capability check or wallet initialization retries every five seconds; incompatible mint capabilities require correction and restart.

Coco 2.0.0 catches individual operation-recovery failures and may return a manager with unresolved work. Those failures do not trigger an additional application retry loop or block new invoices. A paid quote still awaiting a claim can coexist with a ready server; Coco's workers remain responsible for it. Readiness reports successful initialization, not complete recovery, current mint connectivity or continuous processor health.

Two dependency limitations remain:

- If `initializeCoco()` throws after starting workers without returning its manager, the application cannot dispose that manager. Startup retries can leave extra workers until a process restart. Managers returned by the factory are disposed on subsequent initialization failure or shutdown.
- Transient on-chain payout quote-check failures can drop a Coco 2.0.0 polling task, leaving a remotely settled payout locally pending. This can happen during continuous operation and is not detected by readiness. Inspect pending operations with `status`; a restart runs Coco's recovery again, and can settle the saved payout once the mint is reachable. There is no application workaround for the polling defect.

`status` reports the server's readiness and observation times alongside a separate local SQLite snapshot. It does not report a successful-reconciliation timestamp. `status`, `setup`, `verify` and backup never construct another manager or start recovery. The private status socket only reads captured state; no response means readiness is unavailable, not that the server is necessarily stopped.

## Shutdown and startup

Send SIGTERM or SIGINT and let the process exit before stopping its host or starting another copy. The server closes HTTP connections and the status listener, cancels startup retries, waits for application handlers and payout initiation, disposes Coco, then closes SQLite. This does not wait for unpaid invoices or remotely pending payouts to settle. In-flight HTTP responses may be interrupted.

While stopped, the application cannot claim ecash or process payouts. A payer may still pay an already-issued invoice directly at the mint, or the mint may settle a submitted payout. Neither event starts the application. The owner, supervisor or hosting platform starts a new `serve` process, which initializes Coco against the saved database. Coco's recovery and workers handle the saved payments. Run only one active server per database.

## Repeatable integration checks

Run `bun test tests/restart.test.ts tests/live-status.test.ts tests/payouts.test.ts`. These checks use public HTTP routes, read-only status, real SQLite and a cryptographic mint fixture; no manager internals are mocked.

- Startup completes despite failed checks for an old receiving quote. A new invoice can be created while the saved payment remains unclaimed. After quote checks recover, Coco claims the saved payment once and triggers one payout.
- A paid quote persisted before operation preparation does not block readiness while issuance is unavailable. Coco's default processor claims it once issuance returns.
- A child server exits on SIGTERM before an invoice is paid. A new process claims it once and submits one payout. That process exits before remote payout settlement; another start finalizes the saved payout and returned change without another submission. A later receipt uses the next address and index.
- The mint accepts a withdrawal while withholding its HTTP response. Killing the child, settling remotely and starting a new process recovers the original destination and consumed index. A subsequent payout uses the next index after a username change. Every withdrawal POST is counted to detect rejected duplicates too.
- Existing payout tests cover mint/destination changes, reservations and sweeps of available funds. Local status tests cover the client-byte handshake needed for reliable Bun 1.3.14 cross-process reads, using twelve separate CLI processes.

These tests simulate settlement without real funds, Lightning routing or Bitcoin broadcast. The [server deployment guide](server-deployment.md) describes the operating contract, and the [optional Fly guide](fly-deployment.md) retains the earlier controlled container/restart evidence. No cloud deployment is required for these local checks.

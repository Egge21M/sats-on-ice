# Payment recovery after restart

Sats on Ice supports a continuously running server or a full shutdown followed by a new process. Retain the complete SQLite database and runtime configuration between starts. Memory-preserving suspension and warm resume are unsupported; stop `serve` before putting its host to sleep and start a new process afterward. See [ADR 0007](../adr/0007-shutdown-and-startup.md).

The active `serve` process owns startup reconciliation. It initializes Coco, refreshes pending mint quotes and in-flight receiving/payout operations through Coco's public APIs, and then evaluates the selected mint's payout threshold. A successful `initializeCoco()` alone is insufficient: Coco 2.0.0 catches individual recovery failures and can return a manager with unresolved work. These checks run during startup and its retries; HTTP requests, local status and elapsed time do not trigger additional reconciliation passes once ready.

## Coco remains responsible for payments

The integration retains `initializeCoco`'s default watchers, processors and `Manager.on` payment events. During normal operation those workers observe payments and advance saved operations. The application has no separate transport, payment replay loop or continuous processor-health gate.

Startup reconciliation uses `quotes.mint.listPending/refresh`, `ops.mint.listInFlight/refresh` and `ops.melt.listInFlight/refresh`. A paid quote awaiting automatic claim keeps the service unready, including a quote persisted before any operation was prepared. New sweeps wait for startup to finish. If the server stops during payout preparation, the definitely unsubmitted prepared operation is cancelled before execution; its index remains consumed. Once execution starts, the application never replays or reclaims that withdrawal. Coco owns locks, proof restoration, pending settlement and terminal transitions.

Unpaid invoices and remotely confirmed pending payouts are legitimate reconciled states. Startup need not wait for someone to pay every invoice or for every withdrawal to settle. Available proofs at the running server's selected mint determine new sweeps; earlier-mint funds remain separate. Existing operations at earlier mints are checked too, so an unavailable earlier mint can delay readiness. Submitted payouts retain their stored destinations across configuration changes, and new payouts consume the selected destination's shared index.

Prepared operations left by a crash, failed operations and records requiring manual recovery remain visible through status; startup does not automatically execute, cancel or repair them. Reconciliation is not a proof-by-proof audit of every historical balance or a resolution of every historical error. Coco 2.0.0 can also leave workers behind if `initializeCoco()` throws after starting them without returning a manager. The application cannot dispose that missing manager; a process restart may be needed. Returned managers are reused across startup reconciliation retries and disposed on shutdown.

Coco 2.0.0 also has a known runtime polling limitation: transient quote-check failures can drop an on-chain payout polling task, leaving a remotely settled payout locally pending until a process restart reconciles it. This can happen during continuous operation. Removing suspension support does not fix that dependency defect, and readiness does not detect it. Inspect pending operations with `status`; restarting `serve` against the same database runs startup recovery without replaying the payout.

## Shutdown and startup

Send SIGTERM or SIGINT and let the process exit before stopping its host or starting another copy. The server closes HTTP connections and the status listener, cancels startup retries, waits for pending application handlers and payout initiation, disposes Coco, then closes SQLite. This does not wait for unpaid invoices or remotely pending payouts to settle. In-flight HTTP responses may be interrupted.

While stopped, the application cannot claim ecash or process payouts. A payer may still pay an already-issued invoice directly at the mint, or the mint may settle a submitted payout. Neither event starts the application. The owner, supervisor or hosting platform must start a new `serve` process; it recovers the persisted state before becoming ready. Abrupt termination is also covered by persisted operation recovery, but owners should allow clean shutdown when possible. Run only one active server per database.

## Readiness and local inspection

`GET /readyz` returns 503 during startup validation or reconciliation, and 200 only after a successful pass. Payment routes likewise refuse new invoices while unready. Transient startup failures retry every five seconds with a safe diagnostic; incompatible mint capabilities require correction and restart. After startup the readiness route reports recorded state without probing the mint.

`status` displays readiness, observation times and the successful startup reconciliation time. Its SQLite balance is always labelled a local snapshot, not freshly reconciled by that command. `status`, `setup`, `verify` and backup never create another manager or start recovery. A live status request only reads the existing server's captured state. Missing socket response means live readiness is unavailable, not that the process is necessarily stopped.

The local socket protocol waits for a client byte before sending its snapshot. This fixes a Bun 1.3.14 cross-process race in which immediate server send-and-close produced `ECONNREFUSED` in the client despite a successful OS connect. The regression test uses twelve separate CLI processes.

## Repeatable integration checks

Run `bun test tests/restart.test.ts tests/live-status.test.ts tests/payouts.test.ts`. These checks use public HTTP routes, read-only status, real SQLite and a cryptographic mint fixture; no manager internals are mocked.

- Startup with failed quote checks remains unready and consumes no index; restored connectivity leads to one claim and one sweep.
- A paid quote with no prepared operation stays unready until Coco's default processor claims it.
- A child server exits on SIGTERM before an invoice is paid. A new process claims it once and submits one payout. That process then exits before remote payout settlement; another start finalizes the saved payout and returned change without another submission. A later receipt uses the next address and index.
- The mint accepts a withdrawal while withholding its HTTP response. Killing the child at this boundary, settling remotely and starting a new process recovers the original destination and consumed index. A subsequent payout uses the next index after a username change. Every withdrawal POST is counted, so a rejected duplicate submission would fail the test.
- Existing payout tests retain coverage for changed mint and destination: earlier funds are not swept, submitted payouts recover to their recorded destination, and new payouts use the newly selected key.

These tests simulate settlement without real funds, Lightning routing or Bitcoin broadcast. The [server deployment guide](server-deployment.md) describes the operating contract, and the [optional Fly guide](fly-deployment.md) retains the earlier controlled container/restart evidence. No cloud deployment is required for these local checks.

Validation on 2026-09-29: all seven restart and live-status checks passed (80 assertions), along with typechecking, the production build and strict Fly configuration validation. The full suite passed 108 of 109 tests; the existing affordable pre-swap payout test intermittently exhausted its fee budget and timed out. The same failure reproduced against unchanged commit `e35a0c3` in an isolated checkout, so it is not introduced by removing suspension support. This validation does not claim that unrelated payout test is fixed or that the current template was deployed to Fly.

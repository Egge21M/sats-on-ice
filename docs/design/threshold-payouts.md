# Threshold payouts

Implementation of [issue #4](https://github.com/Egge21M/sats-on-ice/issues/4). Follow ADRs 0001, 0002, 0007, 0008 and 0009: one mint and wallet, sequential allocation before submission, Coco operation ownership, no application keep-awake gate, and observational local CLI commands.

## Initiation and persistence

The active server evaluates spendable sat proofs after startup/resume reconciliation, after a mint operation finalizes, and after payout settlement. New initiation is gated while the server is unready. Coco's available-proof repository excludes inflight and reserved proofs. Eligibility is measured before fees using `balance >= threshold`. A coalescing queue serializes allocation, quoting, preparation and submission. Coco tracks pending settlement independently, so fresh unreserved funds can fund the next payout.

An IMMEDIATE SQLite transaction derives `/0/index` and increments the destination's next payout index. It commits before mint communication; no failure path decrements it. Exhausted indices are refused. The transaction is separate from Coco's later operation transactions. A crash between allocation and preparation can leave a gap. No Bitcoin address history is queried.

A hash of the last attempted proof set prevents repeated failures from continuously allocating indices for unchanged funds in the running process. A new proof set or process restart allows another attempt. This is not an operation recovery mechanism. Only Coco recovers submitted operations; the application neither replays withdrawals nor automatically reclaims ambiguous funds. The documented single-server restriction still applies across processes.

## Sweep budget and fee selection

Coco's public plugin service supplies its Cashu wallet fee calculator. Start with all available sats less the input fees for those proofs, using integer amounts throughout. Request a canonical on-chain quote through `wallet.quotes.melt.create`, select the smallest `fee_reserve`, and pass that option's advertised `fee_index` to `ops.melt.prepare`. Reject empty or ambiguous option identifiers and mismatched address, amount or unit. Requote with a lower recipient amount until the selected reserve fits. No alternative route or application fee cap is introduced.

A balance above the mint's maximum uses a maximum-sized quote only to discover fees. If the full affordable sweep still exceeds the maximum, report the limit rather than submit a partial max-sized payout. Below-minimum or fee-exhausted amounts are reported as unaffordable. Quote adjustment is bounded to 16 attempts; variable fees need not converge. Unused quotes remain in Coco's store and may be polled until expiry.

Coco 2.0.0 may choose a pre-swap if its selected inputs sufficiently exceed the quoted amount plus reserve. Its output builder adds receiver input fees and may prepare more output value than those selected inputs fund. Before execution, compare the actual persisted pre-swap output sum plus the selected input fees to input value. For a shortfall, cancel the still-prepared operation through Coco, reduce the recipient amount, and requote at the same allocated address. This sends no withdrawal and preserves Coco's reservation/counter lifecycle. Preparation failures are surfaced, with no generic retry of possibly executed operations.

Successful direct melts also have their actual selected-input fees checked before submission. The initial all-proof fee allowance can be conservative if Coco selects fewer proofs. Returned fee change and unselected proofs stay spendable; the result is an affordable balance sweep, not a promise of zero remainder or globally optimal proof selection.

## Lifecycle and feedback

Server startup runs Coco melt recovery and enables its melt quote watcher and settlement processor alongside receiving processing. Shutdown detaches payout triggers, waits for current initiation, then disposes Coco before closing SQLite. A prepared operation reached during shutdown is cancelled before submission. There is no busy veto on Fly suspension or wake scheduler.

The server CLI prints allocated addresses, amounts, operation IDs, reserve and pre-swap fee, plus pending/finalized/rolled-back events. Raw library exceptions, proofs and seeds are not logged. Mint finalization/outpoints are reported without claiming Bitcoin confirmation. Offline `verify` does not enable this lifecycle. [Wallet status](wallet-status.md) adds read-only payout inspection and distinguishes environment policy from the running server's captured configuration; the [resume guide](payment-resume.md) covers reconciliation and interrupted-operation checks.

Coco startup recovery can retain prepared operations for owner decision and swallow some recovery failures. This implementation does not assert complete recovery or add a custom recovery engine. A possibly submitted operation is never executed again by the application; new initiation considers only proofs Coco reports available.

## Controlled evidence

Reproduce with `bun test tests/payouts.test.ts` on Bun 1.3.14, Coco core/Bun SQLite 2.0.0 and cashu-ts 5.0.0-rc.4. The SOI fixture in `tests/mint-fixture.ts` signs receiving invoices and Cashu outputs, verifies input signatures, prevents duplicate spending, charges configured input fees, accepts on-chain quotes, and simulates pending or immediate settlement with signed change. It also verifies conservation of value for pre-swaps. There is no Bitcoin node or broadcast and no real funds.

The equality walkthrough receives 999 sats (no payout), then one sat. The resulting payout sends 990 sats to the public BIP84 test address `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`, selects fee identifier 7 from unordered IDs 42/7/19, reserves 10 sats and receives 3 sats back. Next payout index is 1, Coco state is finalized, effective fee is 7 sats, and reopening preserves the 3-sat balance. Its synthetic outpoint is deliberately not evidence of a Bitcoin transaction.

Additional integration cases cover above-threshold sweeping, input fees, underfunded pre-swap cancellation and a funded pre-swap execution, concurrent receipts while a payout is pending, distinct addresses and disjoint inputs, pending settlement, startup with accumulated proofs, restart after mint settlement without replay, unaffordable amounts, mint maximums, quote failures and index exhaustion. These demonstrate the pinned Coco and fixture combination, not interoperability with an external mint or Bitcoin backend.

API references: [Coco melt operations](https://cashubtc.github.io/coco/pages/melt-operations.html), [NUT-30](https://github.com/cashubtc/nuts/blob/main/30.md). Fee and reservation behavior was also inspected in the installed Coco 2.0.0 implementation; the manifest and lockfile remain authoritative.

## Environment changes and destination history

The server captures the environment-selected mint, threshold and active identity on startup. Destination counters are keyed by normalized xpub and shared by identities using that key; allocation uses the captured destination ID even if another local command later selects an identity. Changing the environment and restarting can select a different username, destination, mint or threshold without deleting history. Omitted username/xpub values come from the last active identity.

New sweep attempts use only available sats at the currently selected mint. Funds at previous mints remain in Coco without automatic transfer or new sweeps. Existing operations can still recover, and submitted payouts retain their recorded destination rather than being redirected to the newly active identity. The mint-switch integration test covers old pending settlement, retention of old spendable funds, and new payouts to a new destination with its own counter.

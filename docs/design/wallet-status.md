# Wallet status

Implements [issue #5](https://github.com/Egge21M/sats-on-ice/issues/5) on the environment configuration and identity selection introduced by merged [PR #12](https://github.com/Egge21M/sats-on-ice/pull/12). Configuration still follows [local setup](local-setup.md); there is no database-backed policy editor.

## Observation boundaries

`status` requires `SOI_MINT_URL` and `SOI_PAYOUT_THRESHOLD_SATS` every time. Optional username/xpub values fall back independently to the last active identity. A fresh instance requires both identity values during `setup` or `serve`. Status itself requires existing application state and never initializes it. `InstanceStore.inspectSelection` uses the existing runtime validation, normalized destination keys and identity queries to preview a selection without creating or activating anything. Existing destinations retain their counters, even when the requested username is new.

The report keeps SQLite's last active identity, the inspecting environment's prospective configuration, and a responding server's captured configuration separate. It never substitutes the inspecting environment for a server response. An offline `setup` can change the stored selection while a running server continues using its captured identity/destination/policy. Mint balances are independent of identities.

`openInspectionDatabase` opens the existing file read-only without changing permissions or running application migrations. Coco repository constructors provide the local readers; `repo.init`, `Manager` and `initializeCoco` are never called. Application selection, proofs, quotes and operations are read under one SQLite read transaction, released before querying the local server. These two observations carry separate timestamps and are not claimed to be atomic with each other. Missing Coco tables during initial connectivity failure produce unavailable wallet information. Missing/old application schemas require explicit setup/startup with the deployment environment.

The server exposes an in-memory observation through a Unix socket inside a `0700` directory next to the canonical database path. Each connection receives only captured public configuration, startup/readiness and last-successful-reconciliation timestamps, and the latest safe application payout and invoice diagnostic. It accepts no commands and exposes no wallet secrets. Its snapshot can let the existing server detect a process pause, just like its timer or an HTTP request. Status waits up to two seconds for a response and validates the payload. No public HTTP route or settings table is added. Socket startup failure leaves payments unchanged and emits a safe warning to `serve` output. Clean shutdown closes the listener; a later start reclaims a refused stale socket without replacing a live listener. Long Unix socket paths or unavailable local IPC can make live information unavailable; wallet inspection still works.

A responding server establishes only that it responded at the displayed time. `ready` records capability checks and payment reconciliation after startup or a detected pause, not continuous mint connectivity or processor-health monitoring. The last successful reconciliation time is explicit; the SQLite snapshot remains a separate local observation. Safe invoice failures and the latest payout message help diagnose problems after startup, but these in-memory diagnostics disappear on restart. Persisted Coco error flags and operation states remain inspectable after shutdown; raw errors are withheld because upstream messages may contain proof or seed material. Full application attempt history, processor health and recovery commands are outside this slice.

## Accounting and payout states

Per-mint spendable balance sums unreserved ready sat proofs with bigint arithmetic. Funds reserved in pending payouts sum ready or inflight sat proofs associated with nonterminal on-chain melt operations. This is reserved input value, which can include fees/change; it is not the recipient amount. Other reserved/inflight proofs are reported separately, including orphaned reservations. Spent proofs contribute nothing. Non-sat proofs are flagged and excluded from sat totals.

Mint discovery combines recorded mint URLs with proofs, operations and pending quotes so funds at a former mint are visible even without a current mint registry entry. Outstanding receiving operations include initialization and failed issuance; they never count as spendable ecash. Pending receiving and melt quote counts are shown separately because a quote alone does not establish a payout attempt. Every persisted on-chain melt state, including prepared, rollback and failed states, is shown with the operation's recorded address, never the newly selected destination. Missing quote/transaction information is explicitly unavailable.

Coco 2.0's on-chain quote schema supports `UNPAID`, `PENDING` and `PAID`. It records an `outpoint` at broadcast. The report shows Coco's operation state and remote quote state separately; `PAID` or `finalized` alone does not establish a Bitcoin transaction's confirmation. An outpoint from the quote or finalized operation is labeled broadcast with confirmation unavailable. The pinned repository has no confirmation field/state to display. No chain lookup, inferred confirmation or new settlement model is introduced.

## Repeatable walkthrough and evidence

Run without real funds or external mint access:

```sh
bun test tests/status.test.ts tests/cli.test.ts tests/receiving.test.ts tests/payouts.test.ts
```

These checks extend PR #12's configuration/receiving/payout fixtures and exercise real SQLite repositories and Coco operations:

1. Receive 1,000 sats with a 1,000-sat threshold while the controlled mint leaves the payout pending. Status reports zero spendable sats, 1,000 sats reserved, the original address, and the pending operation. Additional receipts can fund the second address. Settlement leaves six spendable sats across the two payouts and reports broadcast outpoints without claiming confirmation.
2. Start against a temporarily unavailable mint. Status shows the responding server as retrying, and wallet data unavailable until Coco initializes. Payment endpoints remain unready. When the mint returns, startup succeeds and status reports ready. Invoice preparation failures and unaffordable/failed payout quotes appear as timestamped server diagnostics.
3. Leave a payout pending plus 400 spendable sats at the original mint. Inspect with a different mint, username, destination and threshold before restart. SQLite still selects the old identity; the environment previews a new uncreated identity; the server still reports its old captured policy. No indices or identity records change.
4. Restart with that changed configuration after the controlled mint settles the old payout. The new selected mint has zero spendable sats; the old mint has 403 sats, its original payout address and a broadcast outpoint. No new old-mint payout is submitted. Receiving at the new mint pays its new destination at index zero. Switching back reuses the original identity and resumes its next payout index at one.
5. Inspect with no server. Live readiness/configuration are unavailable, while local funds and operations remain visible. Database serialization stays unchanged across status calls, network spies observe no mint requests, missing files/schemas are not created, and seed/proof/raw error material is absent from output. Balances above the safe-integer range remain exact.

These are controlled settlement and local process checks. They do not establish live mint interoperability or Fly warm-resume behavior. When Fly suspends the service, ecash claiming and payout processing may wait for another request or explicit wake. Offline status does not wake Fly, reconcile remote state, initiate sweeps or prove payment readiness. The [resume guide](payment-resume.md) covers the active server lifecycle; see [ADR 0007](../adr/0007-fly-controlled-suspension.md).

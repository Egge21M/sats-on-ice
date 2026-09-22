import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import type { MeltOperation, MeltOperationState, MintOperationState } from "@cashu/coco-core";
import { readRuntimeConfig, runtimeConfigSchema } from "./config.ts";
import { readLiveStatus } from "./live-status.ts";
import { openInspectionDatabase } from "./storage/database.ts";
import { InstanceStore } from "./storage/instance-store.ts";

const meltStates: MeltOperationState[] = ["init", "prepared", "executing", "pending", "failed", "finalized", "rolling_back", "rolled_back"];
const mintStates: MintOperationState[] = ["init", "pending", "executing", "failed"];
const unsettled = (operation: MeltOperation) => !["failed", "finalized", "rolled_back"].includes(operation.state);

async function payoutStatus(repo: SqliteRepositories, operation: MeltOperation) {
  const quote = operation.quoteId
    ? await repo.meltQuoteRepository.getMeltQuote(operation.mintUrl, operation.method, operation.quoteId) : null;
  const outpoint = (quote?.method === "onchain" ? quote.outpoint : undefined) ||
    (operation.state === "finalized" ? operation.finalizedData?.outpoint : undefined) || null;
  // Coco 2.0 reports UNPAID/PENDING/PAID and an outpoint at broadcast. Neither
  // PAID nor local finalization establishes confirmation. The pinned schema has
  // no confirmation state; do not invent one from settlement or elapsed time.
  const remoteState = quote ? String(quote.state) : null;
  const bitcoinState = outpoint ? "broadcast; confirmation unavailable" : "unavailable";
  return {
    id: operation.id, state: operation.state, quoteId: operation.quoteId ?? null,
    amount: "amount" in operation ? operation.amount.toString() : null, unit: operation.unit,
    destination: "address" in operation.methodData ? operation.methodData.address :
      quote?.method === "onchain" ? quote.request : null,
    remoteState, bitcoinState, outpoint,
    updatedAt: operation.updatedAt, remoteObservedAt: quote?.lastObservedRemoteStateAt ?? null,
    hasError: !!operation.error,
  };
}

export async function inspectStatus(path: string, input: unknown = readRuntimeConfig()) {
  const parsed = runtimeConfigSchema.parse(input);
  const connection = openInspectionDatabase(path);
  try {
    // All repository reads share one SQLite snapshot, even while Coco writes.
    // Constructors do not migrate; repo.init() would write and is not called.
    connection.sqlite.exec("BEGIN");
    const selection = new InstanceStore(connection.db).inspectSelection(parsed);
    if (!connection.sqlite.query("SELECT 1 FROM sqlite_master WHERE name = 'coco_cashu_migrations'").get()) {
      connection.sqlite.exec("COMMIT");
      return { observedAt: new Date().toISOString(), ...selection, live: await readLiveStatus(path), walletAvailable: false, mints: [] };
    }
    const repo = new SqliteRepositories({ database: connection.sqlite });
    const [mints, ready, inflight, meltGroups, mintGroups, receivingQuotes, meltQuotes] = await Promise.all([
      repo.mintRepository.getAllMints(),
      repo.proofRepository.getAllReadyProofs(), repo.proofRepository.getInflightProofs(),
      Promise.all(meltStates.map((state) => repo.meltOperationRepository.getByState(state))),
      Promise.all(mintStates.map((state) => repo.mintOperationRepository.getByState(state))),
      repo.mintQuoteRepository.getPendingMintQuotes(), repo.meltQuoteRepository.getPendingMeltQuotes(),
    ]);
    const melts = meltGroups.flat();
    const receipts = mintGroups.flat();
    const proofs = [...ready, ...inflight];
    const urls = new Set([parsed.mintUrl, ...mints.map((mint) => mint.mintUrl),
      ...proofs.map((proof) => proof.mintUrl), ...melts.map((op) => op.mintUrl),
      ...receipts.map((op) => op.mintUrl), ...receivingQuotes.map((q) => q.mintUrl), ...meltQuotes.map((q) => q.mintUrl)]);
    const balances = await Promise.all([...urls].sort().map(async (mintUrl) => {
      const mintMelts = melts.filter((op) => op.mintUrl === mintUrl);
      const pendingPayouts = new Set(mintMelts.filter((op) => op.method === "onchain" && unsettled(op)).map((op) => op.id));
      const mintProofs = proofs.filter((proof) => proof.mintUrl === mintUrl && proof.unit === "sat");
      let spendable = 0n, reserved = 0n, otherUnavailable = 0n;
      for (const proof of mintProofs) {
        if (proof.state === "ready" && !proof.usedByOperationId) spendable += proof.amount.toBigInt();
        else if (proof.usedByOperationId && pendingPayouts.has(proof.usedByOperationId)) reserved += proof.amount.toBigInt();
        else otherUnavailable += proof.amount.toBigInt();
      }
      return {
        mintUrl, selected: mintUrl === parsed.mintUrl,
        spendableSats: spendable.toString(), reservedForPayoutsSats: reserved.toString(),
        otherUnavailableSats: otherUnavailable.toString(),
        nonSatProofs: proofs.filter((proof) => proof.mintUrl === mintUrl && proof.unit !== "sat").length,
        payouts: await Promise.all(mintMelts.filter((op) => op.method === "onchain")
          .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map((op) => payoutStatus(repo, op))),
        receiving: receipts.filter((op) => op.mintUrl === mintUrl).map((op) => ({
          id: op.id, state: op.state, amount: op.amount.toString(), unit: op.unit,
          hasError: !!op.error || !!op.terminalFailure, updatedAt: op.updatedAt,
        })),
        pendingReceivingQuotes: receivingQuotes.filter((q) => q.mintUrl === mintUrl).length,
        pendingMeltQuotes: meltQuotes.filter((q) => q.mintUrl === mintUrl).length,
        otherPendingMelts: mintMelts.filter((op) => op.method !== "onchain" && unsettled(op)).length,
      };
    }));
    const observedAt = new Date().toISOString();
    connection.sqlite.exec("COMMIT");
    const live = await readLiveStatus(path);
    return { observedAt, ...selection, live, walletAvailable: true, mints: balances };
  } finally { connection.close(); }
}

export type WalletStatus = Awaited<ReturnType<typeof inspectStatus>>;
const safe = (value: string) => JSON.stringify(value); // Keep untrusted stored strings on one terminal line.
const time = (value: number | null) => value === null ? "unavailable" : new Date(value).toISOString();

export function formatStatus(status: WalletStatus): string {
  const { lastActiveIdentity: stored, nextStart: next, live } = status;
  const lines = [
    `Local wallet snapshot: ${status.observedAt}; not freshly reconciled with any mint.`,
    `Last active identity in SQLite: ${safe(stored.username)} (identity ${stored.identityId}, destination ${stored.destinationId})`,
    `  Destination key: ${stored.destinationKey}`,
    `  Next payout index: ${stored.nextPayoutIndex}`,
    `Environment selection for next start: ${safe(next.username)} (identity ${next.identityId ?? "new; not created"}, destination ${next.destinationId ?? "new; not created"})`,
    `  Destination key: ${next.destinationKey}`,
    `  Next payout index: ${next.nextPayoutIndex}${next.destinationId === null ? " (initial value; not allocated)" : ""}`,
    `  Mint: ${safe(next.mintUrl)}; payout threshold: ${next.payoutThresholdSats} sats`,
  ];
  if (live) {
    lines.push(`Running server: responded ${live.observedAt}; started ${live.startedAt}`,
      `  Captured configuration: ${safe(live.config.username)} (identity ${live.config.identityId}, destination ${live.config.destinationId})`,
      `  Destination key: ${live.config.destinationKey}`,
      `  Mint: ${safe(live.config.mintUrl)}; payout threshold: ${live.config.payoutThresholdSats} sats`,
      `  Readiness: ${live.readiness} (server observation ${live.readinessObservedAt}); ${safe(live.message)}`);
    if (live.lastInvoiceError) lines.push(`  Last invoice error (${live.lastInvoiceError.observedAt}): ${safe(live.lastInvoiceError.message)}`);
    if (live.lastPayout) lines.push(`  Last payout diagnostic (${live.lastPayout.observedAt}): ${safe(live.lastPayout.message)}`);
    lines.push("  Readiness describes startup capability validation, not a fresh mint probe or processor-health guarantee.");
  } else {
    lines.push("Running server configuration and readiness: unavailable (no local status response).",
      "  Local records and this command's environment do not establish whether a server is running, stopped or suspended.");
  }
  if (!status.walletAvailable) lines.push("Wallet balances and operations: unavailable (Coco repositories have not been initialized).");
  for (const mint of [...status.mints].sort((a, b) => Number(b.selected) - Number(a.selected))) {
    lines.push(`${mint.selected ? "Environment-selected mint" : "Other mint (funds remain separate)"}: ${safe(mint.mintUrl)}`,
      `  ${mint.selected ? "Accumulated balance" : "Remaining spendable balance"}: ${mint.spendableSats} sats`,
      `  Funds reserved in pending payouts: ${mint.reservedForPayoutsSats} sats`,
      `  Other reserved/inflight funds: ${mint.otherUnavailableSats} sats`,
      `  Pending receiving quotes: ${mint.pendingReceivingQuotes}; pending melt quotes: ${mint.pendingMeltQuotes} (quotes alone are not payouts).`);
    if (mint.nonSatProofs) lines.push(`  Non-sat proofs excluded from sat balances: ${mint.nonSatProofs}`);
    if (mint.otherPendingMelts) lines.push(`  Other pending melt operations: ${mint.otherPendingMelts}`);
    for (const receipt of mint.receiving) lines.push(`  Receiving operation ${safe(receipt.id)}: ${receipt.state}; ${receipt.amount} ${safe(receipt.unit)}${receipt.hasError ? "; error recorded (raw details withheld)" : ""}; updated ${time(receipt.updatedAt)}`);
    if (!mint.payouts.length) lines.push("  Payouts: none recorded.");
    for (const payout of mint.payouts) {
      lines.push(`  Payout ${safe(payout.id)}: ${payout.state}; ${payout.amount ?? "unknown amount"} ${safe(payout.unit)}; updated ${time(payout.updatedAt)}`,
        `    Recorded destination: ${payout.destination ? safe(payout.destination) : "unavailable"}`,
        `    Mint quote state: ${payout.remoteState ?? "unavailable"}; last remote observation: ${time(payout.remoteObservedAt)}`,
        `    Bitcoin state: ${payout.bitcoinState}; outpoint: ${payout.outpoint ? safe(payout.outpoint) : "unavailable"}`);
      if (payout.hasError) lines.push("    Error recorded by Coco; raw details withheld because library errors can contain wallet secrets.");
    }
  }
  lines.push("Balances belong to mints, not identities. Status does not claim ecash, move funds, allocate indices or run recovery.",
    "Suspension can defer claims and payouts until a request or explicit wake. Local status success does not establish payment readiness.");
  return lines.join("\n");
}

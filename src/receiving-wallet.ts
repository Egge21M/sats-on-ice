import { initializeCoco, type CocoConfig } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import type { Database } from "bun:sqlite";
import { decode } from "light-bolt11-decoder";
import { payoutFeePlugin, startPayouts } from "./payouts.ts";
import type { ActiveConfig } from "./config.ts";
import type { AmountLimits } from "./mint-capabilities.ts";

/** The server owns this active lifecycle; CLI inspection never enables it. */
export async function openReceivingWallet(
  sqlite: Database,
  seedGetter: () => Promise<Uint8Array>,
  mintUrl: string,
  timing: { pollingIntervalMs?: number; processorIntervalMs?: number } = {},
  payout?: { config: ActiveConfig; limits: AmountLimits; allocate: () => { address: string; index: number }; report: (message: string) => void; canInitiate: () => boolean },
) {
  const repo = new SqliteRepositories({ database: sqlite });
  const subscriptions: CocoConfig["subscriptions"] = timing.pollingIntervalMs === undefined ? undefined : {
    fastPollingIntervalMs: timing.pollingIntervalMs,
    slowPollingIntervalMs: timing.pollingIntervalMs,
  };
  const fees = payoutFeePlugin();
  const wallet = await initializeCoco({
    repo, seedGetter, plugins: [fees.plugin], subscriptions,
    processors: timing.processorIntervalMs === undefined ? undefined : {
      mintOperationProcessor: {
        processIntervalMs: timing.processorIntervalMs,
        initialEnqueueDelayMs: timing.processorIntervalMs,
      },
    },
  });
  let payouts: ReturnType<typeof startPayouts> | undefined;
  try {
    await wallet.mint.addMint(mintUrl, { trusted: true });
    if (payout) payouts = startPayouts({ wallet, repo, fees, ...payout });
    return {
      async reconcile() {
        // Factory recovery is best-effort. Public per-operation refresh surfaces
        // errors, and Coco alone owns redemption, proof recovery and settlement.
        // Quotes can survive a crash before an operation is prepared. Refresh
        // those too; the default processor owns automatic claims for them.
        for (const quote of await wallet.quotes.mint.listPending()) {
          await wallet.quotes.mint.refresh({ mintUrl: quote.mintUrl, quoteId: quote.quoteId });
        }
        for (const operation of await wallet.ops.mint.listInFlight()) {
          const refreshed = await wallet.ops.mint.refresh(operation.id);
          if (refreshed.state === "executing" || refreshed.state === "init" || refreshed.error) {
            throw new Error("Receiving operation requires reconciliation.");
          }
        }
        for (const operation of await wallet.ops.melt.listInFlight()) {
          const refreshed = await wallet.ops.melt.refresh(operation.id);
          if (refreshed.state !== "pending" && refreshed.state !== "finalized" && refreshed.state !== "rolled_back") {
            throw new Error("Payout operation requires reconciliation.");
          }
        }
        if ((await wallet.quotes.mint.listPending()).some((quote) => quote.state === "PAID")) {
          throw new Error("Paid receiving quote is awaiting Coco's claim processor.");
        }
      },
      evaluatePayouts() { payouts?.request(); },
      async createInvoice(amountSats: number) {
        const quote = await wallet.quotes.mint.create({ mintUrl, method: "bolt11", amount: amountSats, unit: "sat" });
        // Validate the actual invoice, not just the mint's quote amount. This
        // decoder checks encoding/amount, not the Lightning invoice signature.
        const invoice = decode(quote.request);
        const amount = invoice.sections.find((section) => section.name === "amount");
        const network = invoice.sections.find((section) => section.name === "coin_network");
        const timestamp = invoice.sections.find((section) => section.name === "timestamp");
        const expirySeconds = invoice.sections.find((section) => section.name === "expiry")?.value ?? 3600;
        const expiry = timestamp ? timestamp.value + expirySeconds : 0;
        if (!amount || BigInt(amount.value) !== BigInt(amountSats) * 1000n || network?.letters !== "bc" ||
            expiry * 1000 <= Date.now()) {
          throw new Error("Mint returned an incompatible invoice.");
        }
        const operation = await wallet.ops.mint.prepare({ quote, amount: amountSats });
        return operation.request;
      },
      async close() { await payouts?.stop(); await wallet.dispose(); },
    };
  } catch (error) {
    await payouts?.stop();
    await wallet.dispose();
    throw error;
  }
}

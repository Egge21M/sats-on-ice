import { Manager, type CocoConfig } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import type { Database } from "bun:sqlite";
import { decode } from "light-bolt11-decoder";
import { assertConfiguredMint } from "./wallet.ts";

/** The server owns this active lifecycle; CLI inspection never enables it. */
export async function openReceivingWallet(
  sqlite: Database,
  seedGetter: () => Promise<Uint8Array>,
  mintUrl: string,
  timing: { pollingIntervalMs?: number; processorIntervalMs?: number } = {},
) {
  const repo = new SqliteRepositories({ database: sqlite });
  await repo.init();
  const subscriptions: CocoConfig["subscriptions"] = timing.pollingIntervalMs === undefined ? undefined : {
    fastPollingIntervalMs: timing.pollingIntervalMs,
    slowPollingIntervalMs: timing.pollingIntervalMs,
  };
  const wallet = new Manager(repo, seedGetter, undefined, undefined, undefined, undefined, undefined, subscriptions);
  try {
    await wallet.initPlugins();
    await assertConfiguredMint(wallet, mintUrl);
    await wallet.mint.addMint(mintUrl, { trusted: true });
    await wallet.reconcileLegacyMintQuotes(mintUrl);
    await wallet.enableMintOperationProcessor({
      processIntervalMs: timing.processorIntervalMs,
      initialEnqueueDelayMs: timing.processorIntervalMs,
    });
    await wallet.enableMintOperationWatcher();
    await wallet.recoverPendingMintOperations();
    return {
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
      close: () => wallet.dispose(),
    };
  } catch (error) {
    await wallet.dispose();
    throw error;
  }
}

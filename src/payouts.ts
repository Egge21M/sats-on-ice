import type { Manager, MeltOperation, OnchainMeltQuote, PreparedMeltOperation } from "@cashu/coco-core";
import type { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import type { Plugin, ServiceMap } from "@cashu/coco-core/plugin";
import type { ActiveConfig } from "./config.ts";
import type { AmountLimits } from "./mint-capabilities.ts";
import { UserError } from "./errors.ts";

class PayoutError extends Error {}

export function lowestFee(quote: OnchainMeltQuote) {
  const options = quote.fee_options;
  if (!options.length || options.some((option) => !Number.isSafeInteger(option.fee_index) || option.fee_index < 0) ||
      new Set(options.map((option) => option.fee_index)).size !== options.length) {
    throw new PayoutError("Mint returned invalid on-chain fee options.");
  }
  return options.reduce((best, option) => option.fee_reserve.lessThan(best.fee_reserve) ? option : best);
}

/** Access fee calculation through Coco's supported plugin services, not private fields. */
export function payoutFeePlugin() {
  let services: Pick<ServiceMap, "walletService">;
  const plugin: Plugin<["walletService"]> = {
    name: "soi-payout-fees", required: ["walletService"],
    onInit(context) { services = context.services; },
  };
  return { plugin, wallet: (mintUrl: string) => services.walletService.getWallet(mintUrl, "sat") };
}

/** A single process owns initiation. Coco owns proofs and every submitted operation. */
export function startPayouts(options: {
  wallet: Manager;
  repo: SqliteRepositories;
  fees: ReturnType<typeof payoutFeePlugin>;
  config: ActiveConfig;
  limits: AmountLimits;
  allocate: () => { address: string; index: number };
  report: (message: string) => void;
  canInitiate: () => boolean;
}) {
  const { wallet, repo, config, limits, report } = options;
  let stopped = false;
  let dirty = false;
  let running: Promise<void> | undefined;
  let lastProofs: string | undefined;

  function progress(operation: MeltOperation) {
    if (operation.method !== "onchain" || operation.mintUrl !== config.mintUrl) return;
    const outpoint = operation.state === "finalized" ? operation.finalizedData?.outpoint : undefined;
    report(`Payout operation ${operation.id}: ${operation.state}${outpoint ? `; outpoint ${outpoint}` : ""}. Mint settlement does not establish Bitcoin confirmation.`);
  }

  async function prepare(address: string, budget: bigint, inputFee: bigint) {
    const amount = budget - inputFee;
    // A max-sized probe discovers the reserve, but never executes a partial sweep.
    let probe = amount > BigInt(limits.max) ? BigInt(limits.max) : amount;
    for (let attempt = 0; attempt < 16; attempt++) {
      if (stopped) return;
      if (probe < BigInt(limits.min)) throw new PayoutError("Balance cannot cover the mint minimum and payout fees.");
      const quote = await wallet.quotes.melt.create({ mintUrl: config.mintUrl, method: "onchain", unit: "sat",
        methodData: { address, amountSats: Number(probe) } });
      if (quote.amount.toBigInt() !== probe || quote.unit !== "sat" || quote.request !== address) {
        throw new PayoutError("Mint returned a mismatched on-chain quote.");
      }
      const fee = lowestFee(quote);
      const affordable = budget - inputFee - fee.fee_reserve.toBigInt();
      if (affordable > BigInt(limits.max)) throw new PayoutError("Sweep exceeds the mint's maximum payout amount.");
      if (probe > affordable) { probe = affordable; continue; }
      if (stopped) return;
      const operation = await wallet.ops.melt.prepare({ quote, feeIndex: fee.fee_index });
      // Coco 2.0 may prepare a pre-swap whose outputs exceed its inputs after
      // receiver fees. Inspect the actual persisted plan before any submission.
      let shortfall: bigint;
      try { shortfall = await fundingShortfall(operation); }
      catch (error) {
        await wallet.ops.melt.cancel(operation.id, "Unable to verify prepared payout funding.");
        throw error;
      }
      if (shortfall > 0n) {
        await wallet.ops.melt.cancel(operation.id, "Requote sweep to include all input and pre-swap fees.");
        probe -= shortfall;
        continue;
      }
      return operation;
    }
    throw new PayoutError("Unable to obtain a stable affordable payout quote after 16 attempts.");
  }

  async function fundingShortfall(operation: PreparedMeltOperation) {
    const cashu = await options.fees.wallet(config.mintUrl);
    const inputs = await repo.proofRepository.getProofsBySecrets(config.mintUrl, operation.inputProofSecrets);
    const fees = cashu.getFeesForProofs(inputs).toBigInt();
    let required = operation.amount.toBigInt() + operation.fee_reserve.toBigInt() + fees;
    if (operation.needsSwap) {
      if (!operation.swapOutputData) throw new PayoutError("Coco did not persist the required pre-swap outputs.");
      const outputs = [...operation.swapOutputData.keep, ...operation.swapOutputData.send];
      required = outputs.reduce((sum, output) => sum + BigInt(output.blindedMessage.amount), fees);
      const send = operation.swapOutputData.send.map((output) => output.blindedMessage);
      const sendAmount = send.reduce((sum, output) => sum + BigInt(output.amount), 0n);
      const meltShortfall = operation.amount.toBigInt() + operation.fee_reserve.toBigInt() +
        cashu.getFeesForProofs(send).toBigInt() - sendAmount;
      const swapShortfall = required - operation.inputAmount.toBigInt();
      return meltShortfall > swapShortfall ? meltShortfall : swapShortfall;
    }
    return required - operation.inputAmount.toBigInt();
  }

  async function sweep() {
    if (!options.canInitiate()) return;
    const proofs = await repo.proofRepository.getAvailableProofs(config.mintUrl, { unit: "sat" });
    const balance = proofs.reduce((sum, proof) => sum + proof.amount.toBigInt(), 0n);
    if (balance < BigInt(config.payoutThresholdSats) || stopped || !options.canInitiate()) return;
    const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify(proofs.map((proof) => proof.secret).sort())).digest("hex");
    // Failed attempts do not burn indices repeatedly for an unchanged proof set.
    if (fingerprint === lastProofs) return;
    lastProofs = fingerprint;
    const { address, index } = options.allocate();
    report(`Payout index ${index} allocated: ${address}; spendable balance ${balance} sats.`);
    const cashu = await options.fees.wallet(config.mintUrl);
    const operation = await prepare(address, balance, cashu.getFeesForProofs(proofs).toBigInt());
    if (!operation) return;
    if (stopped || !options.canInitiate()) {
      await wallet.ops.melt.cancel(operation.id, "Server stopped or requires reconciliation before payout submission.");
      return;
    }
    report(`Payout ${operation.id}: ${operation.amount} sats to ${address}; fee option ${("feeIndex" in operation.methodData ? operation.methodData.feeIndex : "unknown")}, reserve ${operation.fee_reserve} sats, pre-swap fee ${operation.swap_fee} sats.`);
    await wallet.ops.melt.execute(operation.id);
    // No application replay or reclaim after an execution failure.
  }

  function request() {
    if (stopped) return;
    dirty = true;
    if (running) return;
    running = Promise.resolve().then(async () => {
      while (dirty && !stopped) {
        dirty = false;
        try { await sweep(); }
        catch (error) {
          report(error instanceof PayoutError || error instanceof UserError ? error.message : "Payout could not complete. Inspect persisted Coco operations; no submitted payout was replayed. A new receipt or restart can reevaluate spendable funds.");
        }
      }
    }).finally(() => {
      running = undefined;
      if (dirty && !stopped) request();
    });
  }
  // Do not await initiation inside Coco event handlers: its operation lock may
  // still be held. Terminal value movements avoid transient pre-swap balances.
  const unsubscribe = [
    wallet.on("mint-op:finalized", request),
    wallet.on("melt-op:pending", ({ operation }) => progress(operation)),
    wallet.on("melt-op:finalized", ({ operation }) => { progress(operation); request(); }),
    wallet.on("melt-op:rolled-back", ({ operation }) => progress(operation)),
  ];
  request();
  return { request, async stop() { stopped = true; unsubscribe.forEach((off) => off()); await running; } };
}

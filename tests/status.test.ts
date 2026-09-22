import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Amount, type CoreProof, type MeltOperation, type MeltQuote } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { HDKey } from "@scure/bip32";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupInstance } from "../src/setup.ts";
import { formatStatus, inspectStatus } from "../src/status.ts";
import { openDatabase } from "../src/storage/database.ts";
import { InstanceStore } from "../src/storage/instance-store.ts";
import { FIRST_ADDRESS, SETUP, XPUB } from "./fixtures.ts";

let directory: string;
let database: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "soi-status-")); database = join(directory, "wallet.sqlite"); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const otherKey = HDKey.fromMasterSeed(new Uint8Array(32).fill(3)).derive("m/84'/0'/0'").publicExtendedKey;

test("status previews new selections offline without changing seed, identity, counters, wallet state or migrations", async () => {
  await setupInstance(database, SETUP);
  const connection = openDatabase(database, false);
  const store = new InstanceStore(connection.db);
  connection.sqlite.transaction(() => store.allocatePayout(1)).immediate();
  const digest = () => new Bun.CryptoHasher("sha256").update(connection.sqlite.serialize()).digest("hex");
  const before = digest();
  const seed = Buffer.from(store.getSeed());
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    () => { throw new Error("Unexpected mint request"); }, { preconnect: () => {} },
  ));
  try {
    const renamed = await inspectStatus(database, { mintUrl: "https://next.example", payoutThresholdSats: 500, username: "bob" });
    expect(renamed.lastActiveIdentity.username).toBe("alice");
    expect(renamed.nextStart).toMatchObject({ username: "bob", identityId: null, destinationKey: XPUB, nextPayoutIndex: 1, destinationId: 1 });
    expect(renamed.live).toBeNull();
    const changed = await inspectStatus(database, { ...SETUP, destinationKey: otherKey });
    expect(changed.nextStart).toMatchObject({ identityId: null, destinationId: null, nextPayoutIndex: 0 });
    expect(changed.lastActiveIdentity.nextPayoutIndex).toBe(1);
    expect(digest()).toBe(before);
    const output = formatStatus(renamed) + formatStatus(changed);
    expect(output).toContain("Running server configuration and readiness: unavailable");
    expect(output).toContain("not freshly reconciled");
    expect(output).not.toContain(seed.toString("hex"));
    expect(output).not.toContain(seed.toString("base64"));
    expect(network).not.toHaveBeenCalled();
    expect(existsSync(`${database}.status`)).toBe(false);
  } finally { network.mockRestore(); connection.close(); }
});

test("status creates neither a missing database nor schemas in an empty database", async () => {
  await expect(inspectStatus(database, SETUP)).rejects.toThrow("Unable to read");
  expect(existsSync(database)).toBe(false);
  const empty = new Database(database);
  empty.close();
  const size = statSync(database).size;
  await expect(inspectStatus(database, SETUP)).rejects.toThrow("status applies no migrations");
  expect(statSync(database).size).toBe(size);
});

test("balances are exact and separated by mint; reservations, operation errors and recorded destinations are preserved", async () => {
  await setupInstance(database, SETUP);
  const connection = openDatabase(database, false);
  const repo = new SqliteRepositories({ database: connection.sqlite });
  const oldMint = "https://previous.example";
  const secret = "DO-NOT-PRINT-proof-or-library-error";
  try {
    const proof = (amount: bigint, suffix: string, state: CoreProof["state"] = "ready", usedByOperationId?: string, unit = "sat"): CoreProof => ({
      mintUrl: SETUP.mintUrl, id: "0011223344556677", amount: Amount.from(amount), unit,
      secret: secret + suffix, C: "02" + "11".repeat(32), state, usedByOperationId,
    });
    await repo.proofRepository.saveProofs(SETUP.mintUrl, [proof(1n << 53n, "big"), proof(1n, "one"),
      proof(8n, "reserved", "ready", "payout"), proof(16n, "inflight", "inflight", "payout"),
      proof(32n, "spent", "spent", "payout"), proof(64n, "orphan", "ready", "missing"), proof(128n, "usd", "ready", undefined, "usd")]);
    await repo.proofRepository.saveProofs(oldMint, [{ ...proof(42n, "old"), mintUrl: oldMint }]);
    const operation: MeltOperation = { id: "payout", mintUrl: SETUP.mintUrl, method: "onchain",
      methodData: { address: FIRST_ADDRESS, amountSats: Amount.from(20) },
      unit: "sat", state: "pending", createdAt: 1000, updatedAt: 2000, quoteId: "quote", amount: Amount.from(20),
      fee_reserve: Amount.from(4), inputAmount: Amount.from(24), swap_fee: Amount.from(0), needsSwap: false,
      inputProofSecrets: [secret + "reserved", secret + "inflight"], changeOutputData: { keep: [], send: [] }, error: secret };
    await repo.meltOperationRepository.create(operation);
    await repo.meltOperationRepository.create({ id: "old-init", state: "init", mintUrl: oldMint, method: "onchain",
      methodData: { address: FIRST_ADDRESS, amountSats: Amount.from(20) }, unit: "sat", createdAt: 1, updatedAt: 1 });
    await repo.mintOperationRepository.create({ id: "old-receipt", state: "init", mintUrl: oldMint,
      method: "bolt11", methodData: {}, quoteId: "unpaid", amount: Amount.from(100), unit: "sat", createdAt: 1, updatedAt: 1 });
    const quote: MeltQuote<"onchain"> = { mintUrl: SETUP.mintUrl, method: "onchain", quoteId: "quote", quote: "quote",
      amount: Amount.from(20), request: FIRST_ADDRESS, unit: "sat", state: "PENDING",
      fee_options: [{ fee_index: 0, fee_reserve: Amount.from(4), estimated_blocks: 1 }],
      expiry: 9999999999, createdAt: 1000, updatedAt: 2000, lastObservedRemoteStateAt: 2000 };
    await repo.meltQuoteRepository.upsertMeltQuote(quote);
    const pending = await inspectStatus(database, { ...SETUP, destinationKey: otherKey });
    const current = pending.mints.find((mint) => mint.selected)!;
    expect(current).toMatchObject({ spendableSats: "9007199254740993", reservedForPayoutsSats: "24", otherUnavailableSats: "64", nonSatProofs: 1 });
    expect(current.payouts[0]).toMatchObject({ state: "pending", destination: FIRST_ADDRESS, hasError: true, outpoint: null, remoteState: "PENDING" });
    const old = pending.mints.find((mint) => mint.mintUrl === oldMint)!;
    expect(old.spendableSats).toBe("42");
    expect(old.receiving[0]?.id).toBe("old-receipt");
    expect(old.payouts[0]?.id).toBe("old-init");
    expect(formatStatus(pending)).not.toContain(secret);
    expect(formatStatus(pending)).toContain("Error recorded by Coco");
    const outpoint = `${"ab".repeat(32)}:0`;
    await repo.meltQuoteRepository.upsertMeltQuote({ ...quote, state: "PAID", outpoint });
    await repo.meltOperationRepository.update({ ...operation, state: "finalized", finalizedData: { outpoint } });
    const broadcast = (await inspectStatus(database, SETUP)).mints.find((mint) => mint.selected)!.payouts[0]!;
    expect(broadcast).toMatchObject({ state: "finalized", bitcoinState: "broadcast; confirmation unavailable", outpoint });
    await repo.meltQuoteRepository.upsertMeltQuote({ ...quote, state: "PAID" });
    await repo.meltOperationRepository.update({ ...operation, state: "finalized" });
    expect((await inspectStatus(database, SETUP)).mints.find((mint) => mint.selected)!.payouts[0]!.bitcoinState).toBe("unavailable");
  } finally { connection.close(); }
});

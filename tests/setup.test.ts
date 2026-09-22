import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Amount, Manager, type CoreProof } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { HDKey } from "@scure/bip32";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setupInstance, verifyInstance } from "../src/setup.ts";
import { ConfigStore } from "../src/storage/config-store.ts";
import { openDatabase } from "../src/storage/database.ts";
import { identity, settings, walletSecret } from "../src/storage/schema.ts";
import { FIRST_ADDRESS, SETUP, XPUB } from "./fixtures.ts";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sats-on-ice-test-"));
  path = join(directory, "instance.sqlite");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function seedDigest(): string {
  const connection = openDatabase(path, false);
  try {
    return new Bun.CryptoHasher("sha256").update(new ConfigStore(connection.db).getSeed()).digest("hex");
  } finally {
    connection.close();
  }
}

describe("local setup", () => {
  test("tightens existing WAL and SHM permissions before reopening wallet state", async () => {
    await setupInstance(path, SETUP);
    const held = openDatabase(path, false);
    try {
      held.sqlite.query("SELECT * FROM soi_identity").all();
      for (const suffix of ["-wal", "-shm"]) {
        expect(existsSync(`${path}${suffix}`)).toBe(true);
        chmodSync(`${path}${suffix}`, 0o666);
      }
      expect((await verifyInstance(path)).accumulatedBalanceSats).toBe("0");
      for (const suffix of ["", "-wal", "-shm"]) expect(statSync(`${path}${suffix}`).mode & 0o777).toBe(0o600);
    } finally { held.close(); }
  });

  test("creates zero-balance setup offline, reopens it, and never consumes the preview index", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      () => { throw new Error("Unexpected network access"); },
      { preconnect: () => { throw new Error("Unexpected network access"); } },
    ));
    try {
      const result = await setupInstance(path, SETUP);
      expect(result).toEqual({
        created: true,
        config: { ...SETUP, destinationKey: XPUB, nextPayoutIndex: 0 },
        firstPayoutAddress: FIRST_ADDRESS,
        accumulatedBalanceSats: "0",
      });
      const digest = seedDigest();
      expect(await setupInstance(path, { ...SETUP, destinationKey: XPUB })).toEqual({ ...result, created: false });
      expect(await verifyInstance(path)).toEqual({ ...result, created: false });
      expect(seedDigest()).toBe(digest);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test.each(["https://mint.example", "https://mint.example/cashu"])("repeated setup preserves state with trailing slashes on %s", async (mintUrl) => {
    const input = { ...SETUP, mintUrl: `${mintUrl}///` };
    const result = await setupInstance(path, input);
    const digest = seedDigest();
    expect(result.config.mintUrl).toBe(mintUrl);
    expect(await setupInstance(path, input)).toEqual({ ...result, created: false });
    expect(await setupInstance(path, { ...SETUP, mintUrl })).toEqual({ ...result, created: false });
    expect(await verifyInstance(path)).toEqual({ ...result, created: false });
    expect(seedDigest()).toBe(digest);
    const connection = openDatabase(path, false);
    try {
      expect(connection.db.select().from(settings).where(eq(settings.key, "mintUrl")).get()?.value).toBe(JSON.stringify(mintUrl));
    } finally {
      connection.close();
    }
  });

  test("rejects conflicting setup without changing seed, identity, mint or index", async () => {
    await setupInstance(path, SETUP);
    const digest = seedDigest();
    const connection = openDatabase(path, false);
    connection.db.update(identity).set({ nextPayoutIndex: 7 }).run();
    connection.close();
    const otherKey = HDKey.fromMasterSeed(new Uint8Array(32).fill(2)).derive("m/84'/0'/0'").publicExtendedKey;
    for (const patch of [{ username: "bob" }, { mintUrl: "https://other.example" }, { destinationKey: otherKey }, { payoutThresholdSats: 2000 }]) {
      await expect(setupInstance(path, { ...SETUP, ...patch })).rejects.toThrow("Setup already exists");
    }
    const reopened = await setupInstance(path, SETUP);
    expect(reopened.config).toEqual({ ...SETUP, destinationKey: XPUB, nextPayoutIndex: 7 });
    expect(seedDigest()).toBe(digest);
  });

  test("invalid input and verification of a missing database do not create wallet files", async () => {
    await expect(setupInstance(path, { ...SETUP, payoutThresholdSats: 0 })).rejects.toThrow();
    await expect(verifyInstance(path)).rejects.toThrow("Run setup first");
    expect(existsSync(path)).toBe(false);
  });

  test("a failed setup transaction rolls back the seed, settings and identity together", async () => {
    const connection = openDatabase(path, true);
    connection.sqlite.exec("CREATE TRIGGER reject_identity BEFORE INSERT ON soi_identity BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(setupInstance(path, SETUP)).rejects.toThrow();
    for (const table of [walletSecret, settings, identity]) {
      expect(connection.db.select().from(table).all().length).toBe(0);
    }
    connection.sqlite.exec("DROP TRIGGER reject_identity");
    connection.close();
    expect((await setupInstance(path, SETUP)).created).toBe(true);
  });

  test("does not regenerate a missing seed or adopt orphaned Coco tables", async () => {
    await setupInstance(path, SETUP);
    const connection = openDatabase(path, false);
    connection.db.delete(walletSecret).run();
    await expect(setupInstance(path, SETUP)).rejects.toThrow("incomplete");
    expect(connection.db.select().from(walletSecret).all().length).toBe(0);
    connection.db.delete(identity).run();
    connection.db.delete(settings).run();
    await expect(setupInstance(path, SETUP)).rejects.toThrow("replacement seed will not be generated");
    connection.close();
  });

  test("validates stored values by setting key and preserves invalid data for recovery", async () => {
    await setupInstance(path, SETUP);
    const connection = openDatabase(path, false);
    connection.db.update(settings).set({ value: JSON.stringify("1000") }).where(eq(settings.key, "payoutThresholdSats")).run();
    await expect(verifyInstance(path)).rejects.toThrow("Stored configuration");
    await expect(setupInstance(path, SETUP)).rejects.toThrow("Stored configuration");
    expect(connection.db.select().from(settings).where(eq(settings.key, "payoutThresholdSats")).get()?.value).toBe('"1000"');
    connection.close();
  });

  test("SQLite enforces a singleton identity and integer nonnegative next payout index", async () => {
    await setupInstance(path, SETUP);
    const connection = openDatabase(path, false);
    try {
      expect(() => connection.db.insert(identity).values({ id: 2, username: "bob", destinationKey: XPUB }).run()).toThrow();
      for (const index of [-1, 0.5, 0x80000001]) {
        expect(() => connection.db.update(identity).set({ nextPayoutIndex: index }).run()).toThrow();
      }
    } finally {
      connection.close();
    }
  });
});

test("local inspection sums spendable sats exactly and excludes reserved, inflight, spent and non-sat proofs", async () => {
  await setupInstance(path, SETUP);
  const connection = openDatabase(path, false);
  try {
    const repo = new SqliteRepositories({ database: connection.sqlite });
    await repo.init();
    const proofs: CoreProof[] = [1n << 53n, 1n, 8n, 2n, 16n, 32n].map((amount, index) => ({
      id: "0011223344556677", mintUrl: SETUP.mintUrl, unit: index === 5 ? "usd" : "sat", amount: Amount.from(amount),
      secret: `public-balance-proof-${index}`, C: "02" + "11".repeat(32),
      state: index === 3 ? "inflight" : index === 4 ? "spent" : "ready",
      ...(index === 2 ? { usedByOperationId: "pending-test-payout" } : {}),
    }));
    await repo.proofRepository.saveProofs(SETUP.mintUrl, proofs);
    expect((await verifyInstance(path)).accumulatedBalanceSats).toBe("9007199254740993");
    expect((await setupInstance(path, SETUP)).accumulatedBalanceSats).toBe("9007199254740993");
  } finally { connection.close(); }
});

test("both migration systems preserve application state, Coco counters, keyring and proofs across reopen", async () => {
  await setupInstance(path, SETUP);
  const digest = seedDigest();
  const connection = openDatabase(path, false);
  const repo = new SqliteRepositories({ database: connection.sqlite });
  await repo.init();
  const store = new ConfigStore(connection.db);
  // Exercise Coco's seed/keyring compatibility with a test-only offline manager.
  const wallet = new Manager(repo, async () => store.getSeed());
  const publicKey = (await wallet.keyring.generateKeyPair()).publicKeyHex;
  // Coco's P2PK keyring serializes the Schnorr x-only key with an even-y prefix.
  const expectedPublicKey = "02" + Buffer.from(HDKey.fromMasterSeed(store.getSeed()).derive("m/129373'/10'/0'/0'/0").publicKey!.slice(1)).toString("hex");
  expect(publicKey).toBe(expectedPublicKey);
  await repo.counterRepository.setCounter(SETUP.mintUrl, "0011223344556677", 42);
  const proofs: CoreProof[] = [4, 8, 2].map((amount, index) => ({
    id: "0011223344556677", mintUrl: SETUP.mintUrl, unit: "sat", amount: Amount.from(amount),
    secret: `public-test-proof-${index}`, C: "02" + "11".repeat(32),
    state: index === 2 ? "inflight" : "ready",
    ...(index === 1 ? { usedByOperationId: "pending-test-payout" } : {}),
  }));
  await repo.proofRepository.saveProofs(SETUP.mintUrl, proofs);
  connection.db.update(identity).set({ nextPayoutIndex: 5 }).run();
  const migrationIds = connection.sqlite.query("SELECT id FROM coco_cashu_migrations ORDER BY id").all();
  await wallet.dispose();
  // Disposing Coco must leave the caller-owned shared SQLite connection open.
  expect(store.load()?.nextPayoutIndex).toBe(5);
  connection.close();

  const result = await setupInstance(path, SETUP);
  expect(result.config.nextPayoutIndex).toBe(5);
  expect(result.accumulatedBalanceSats).toBe("4"); // Reserved and inflight proofs are excluded.
  expect(seedDigest()).toBe(digest);
  const reopened = openDatabase(path, false);
  const reopenedRepo = new SqliteRepositories({ database: reopened.sqlite });
  await reopenedRepo.init();
  const reopenedWallet = new Manager(reopenedRepo, async () => new ConfigStore(reopened.db).getSeed());
  try {
    expect((await reopenedWallet.keyring.getKeyPair(publicKey))?.publicKeyHex).toBe(publicKey);
    expect((await reopenedRepo.counterRepository.getCounter(SETUP.mintUrl, "0011223344556677"))?.counter).toBe(42);
    expect((await reopenedRepo.proofRepository.getReadyProofs(SETUP.mintUrl)).length).toBe(2);
    expect((await reopenedRepo.proofRepository.getInflightProofs()).length).toBe(1);
    expect((await reopenedRepo.proofRepository.getReservedProofs()).length).toBe(1);
    expect(reopened.sqlite.query("SELECT id FROM coco_cashu_migrations ORDER BY id").all()).toEqual(migrationIds);
    expect(reopened.sqlite.query("SELECT count(*) AS count FROM soi_migrations").get()).toEqual({ count: 1 });
  } finally {
    await reopenedWallet.dispose();
    reopened.close();
  }
});

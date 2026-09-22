import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Amount, Manager, type CoreProof } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { HDKey } from "@scure/bip32";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setupInstance, verifyInstance } from "../src/setup.ts";
import { InstanceStore } from "../src/storage/instance-store.ts";
import { openDatabase } from "../src/storage/database.ts";
import { activeIdentity, destination, identity, walletSecret } from "../src/storage/schema.ts";
import { FIRST_ADDRESS, SETUP, XPUB } from "./fixtures.ts";
import { derivePayoutAddress } from "../src/destination.ts";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sats-on-ice-test-"));
  path = join(directory, "instance.sqlite");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function seedDigest(): string {
  const connection = openDatabase(path, false);
  try { return new Bun.CryptoHasher("sha256").update(new InstanceStore(connection.db).getSeed()).digest("hex"); }
  finally { connection.close(); }
}
const policy = { mintUrl: SETUP.mintUrl, payoutThresholdSats: SETUP.payoutThresholdSats };

test("setup and inspection stay offline, preserve the seed, and require no persisted mint or threshold", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    () => { throw new Error("Unexpected network access"); },
    { preconnect: () => { throw new Error("Unexpected network access"); } },
  ));
  try {
    const result = await setupInstance(path, SETUP);
    expect(result).toEqual({ created: true, config: { ...SETUP, destinationKey: XPUB,
      identityId: 1, destinationId: 1, nextPayoutIndex: 0 }, firstPayoutAddress: FIRST_ADDRESS, accumulatedBalanceSats: "0" });
    const digest = seedDigest();
    expect(await setupInstance(path, { ...SETUP, destinationKey: XPUB })).toEqual({ ...result, created: false });
    expect(await verifyInstance(path, policy)).toEqual({ ...result, created: false });
    expect(seedDigest()).toBe(digest);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(fetch).not.toHaveBeenCalled();
    const connection = openDatabase(path, false);
    try { expect(connection.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'soi_settings'").all()).toEqual([]); }
    finally { connection.close(); }
  } finally { fetch.mockRestore(); }
});

test("identity switches share destination counters, reuse prior identities and fall back one omitted field at a time", async () => {
  const first = await setupInstance(path, SETUP);
  const digest = seedDigest();
  const connection = openDatabase(path, false);
  const store = new InstanceStore(connection.db);
  const allocate = (id: number) => connection.sqlite.transaction(() => store.allocatePayout(id)).immediate();
  try {
    expect(allocate(first.config.destinationId).index).toBe(0);
    const renamed = await setupInstance(path, { ...policy, username: "bob" });
    expect(renamed.config.destinationId).toBe(first.config.destinationId);
    expect(renamed.config.nextPayoutIndex).toBe(1);
    expect(renamed.config.identityId).not.toBe(first.config.identityId);
    expect(allocate(renamed.config.destinationId).index).toBe(1);
    const otherKey = HDKey.fromMasterSeed(new Uint8Array(32).fill(2)).derive("m/84'/0'/0'").publicExtendedKey;
    const changed = await setupInstance(path, { ...policy, destinationKey: otherKey });
    expect(changed.config.username).toBe("bob");
    expect(changed.config.nextPayoutIndex).toBe(0);
    expect(changed.config.destinationId).not.toBe(first.config.destinationId);
    expect(allocate(changed.config.destinationId).index).toBe(0);
    // Allocations are bound to a running server's destination, not the mutable active selection.
    expect(allocate(first.config.destinationId).index).toBe(2);
    const returned = await setupInstance(path, SETUP);
    expect(returned.created).toBe(false);
    expect(returned.config.identityId).toBe(first.config.identityId);
    expect(returned.config.nextPayoutIndex).toBe(3);
    const next = allocate(first.config.destinationId);
    expect(next).toEqual({ index: 3, address: derivePayoutAddress(XPUB, 3) });
    expect((await verifyInstance(path, policy)).config.identityId).toBe(first.config.identityId);
    expect(connection.db.select().from(identity).all()).toHaveLength(3);
    expect(connection.db.select().from(destination).all()).toHaveLength(2);
    expect(seedDigest()).toBe(digest);
  } finally { connection.close(); }
});

test("mint and threshold changes take effect without creating identities or replacing the seed", async () => {
  const first = await setupInstance(path, SETUP);
  const digest = seedDigest();
  const changed = await setupInstance(path, { ...policy, mintUrl: "https://other.example///", payoutThresholdSats: 7 });
  expect(changed.config.identityId).toBe(first.config.identityId);
  expect(changed.config.mintUrl).toBe("https://other.example");
  expect(changed.config.payoutThresholdSats).toBe(7);
  expect((await verifyInstance(path, policy)).config.mintUrl).toBe(SETUP.mintUrl);
  expect(seedDigest()).toBe(digest);
});

test("verification never creates or activates a requested identity", async () => {
  const first = await setupInstance(path, SETUP);
  const second = await setupInstance(path, { ...policy, username: "bob" });
  expect((await verifyInstance(path, SETUP)).config.identityId).toBe(first.config.identityId);
  expect((await verifyInstance(path, policy)).config.identityId).toBe(second.config.identityId);
  await expect(verifyInstance(path, { ...policy, username: "carol" })).rejects.toThrow("not been initialized");
  expect((await verifyInstance(path, policy)).config.identityId).toBe(second.config.identityId);
});

test("fresh instances require identity values; invalid configuration never creates a database", async () => {
  await expect(setupInstance(path, { ...SETUP, payoutThresholdSats: 0 })).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
  await expect(verifyInstance(path, policy)).rejects.toThrow("Run setup first");
  expect(existsSync(path)).toBe(false);
  await expect(setupInstance(path, policy)).rejects.toThrow("SOI_USERNAME and SOI_XPUB");
  const connection = openDatabase(path, false);
  try {
    expect(connection.db.select().from(walletSecret).all()).toHaveLength(0);
    expect(connection.db.select().from(identity).all()).toHaveLength(0);
  } finally { connection.close(); }
});

test("identity selection and seed creation roll back together on persistence failure", async () => {
  const connection = openDatabase(path, true);
  try {
    connection.sqlite.exec("CREATE TRIGGER reject_active BEFORE INSERT ON soi_active_identity BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(setupInstance(path, SETUP)).rejects.toThrow();
    for (const table of [walletSecret, destination, identity, activeIdentity]) expect(connection.db.select().from(table).all()).toHaveLength(0);
    connection.sqlite.exec("DROP TRIGGER reject_active");
    const first = await setupInstance(path, SETUP);
    const digest = seedDigest();
    connection.sqlite.exec("CREATE TRIGGER reject_switch BEFORE UPDATE ON soi_active_identity BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(setupInstance(path, { ...policy, username: "bob" })).rejects.toThrow();
    expect((await verifyInstance(path, policy)).config.identityId).toBe(first.config.identityId);
    expect(connection.db.select().from(identity).all()).toHaveLength(1);
    expect(seedDigest()).toBe(digest);
  } finally { connection.close(); }
});

test("missing seed or incomplete active identity is never silently replaced", async () => {
  await setupInstance(path, SETUP);
  const connection = openDatabase(path, false);
  try {
    connection.db.delete(activeIdentity).run();
    await expect(setupInstance(path, SETUP)).rejects.toThrow("incomplete");
    connection.db.delete(walletSecret).run();
    await expect(setupInstance(path, SETUP)).rejects.toThrow("replacement seed will not be generated");
    connection.db.delete(identity).run();
    connection.db.delete(destination).run();
    await expect(setupInstance(path, SETUP)).rejects.toThrow("replacement seed will not be generated");
    expect(connection.db.select().from(walletSecret).all()).toHaveLength(0);
  } finally { connection.close(); }
});

test("stored identity validation and relational constraints protect counters and references", async () => {
  const first = await setupInstance(path, SETUP);
  const connection = openDatabase(path, false);
  try {
    expect(() => connection.db.insert(destination).values({ xpub: XPUB }).run()).toThrow();
    expect(() => connection.db.insert(identity).values({ username: "alice", destinationId: first.config.destinationId }).run()).toThrow();
    expect(() => connection.db.insert(identity).values({ username: "bob", destinationId: 999 }).run()).toThrow();
    expect(() => connection.db.insert(activeIdentity).values({ id: 2, identityId: first.config.identityId }).run()).toThrow();
    for (const index of [-1, 0.5, 0x80000001]) expect(() => connection.db.update(destination).set({ nextPayoutIndex: index }).run()).toThrow();
    connection.db.update(identity).set({ username: "INVALID" }).run();
    await expect(verifyInstance(path, policy)).rejects.toThrow("Stored identity");
    expect(connection.db.select().from(identity).get()?.username).toBe("INVALID");
  } finally { connection.close(); }
});

test("tightens existing WAL and SHM permissions before reopening wallet state", async () => {
  await setupInstance(path, SETUP);
  const held = openDatabase(path, false);
  try {
    held.sqlite.query("SELECT * FROM soi_identity").all();
    for (const suffix of ["-wal", "-shm"]) { expect(existsSync(`${path}${suffix}`)).toBe(true); chmodSync(`${path}${suffix}`, 0o666); }
    await verifyInstance(path, policy);
    for (const suffix of ["", "-wal", "-shm"]) expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
  } finally { held.close(); }
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
    expect((await verifyInstance(path, SETUP)).accumulatedBalanceSats).toBe("9007199254740993");
    expect((await setupInstance(path, SETUP)).accumulatedBalanceSats).toBe("9007199254740993");
  } finally { connection.close(); }
});

test("both migration systems preserve application state, Coco counters, keyring and proofs across reopen", async () => {
  await setupInstance(path, SETUP);
  const digest = seedDigest();
  const connection = openDatabase(path, false);
  const repo = new SqliteRepositories({ database: connection.sqlite });
  await repo.init();
  const store = new InstanceStore(connection.db);
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
  connection.db.update(destination).set({ nextPayoutIndex: 5 }).run();
  const migrationIds = connection.sqlite.query("SELECT id FROM coco_cashu_migrations ORDER BY id").all();
  await wallet.dispose();
  // Disposing Coco must leave the caller-owned shared SQLite connection open.
  expect(store.load(policy)?.nextPayoutIndex).toBe(5);
  connection.close();

  const result = await setupInstance(path, SETUP);
  expect(result.config.nextPayoutIndex).toBe(5);
  expect(result.accumulatedBalanceSats).toBe("4"); // Reserved and inflight proofs are excluded.
  expect(seedDigest()).toBe(digest);
  const reopened = openDatabase(path, false);
  const reopenedRepo = new SqliteRepositories({ database: reopened.sqlite });
  await reopenedRepo.init();
  const reopenedWallet = new Manager(reopenedRepo, async () => new InstanceStore(reopened.db).getSeed());
  try {
    expect((await reopenedWallet.keyring.getKeyPair(publicKey))?.publicKeyHex).toBe(publicKey);
    expect((await reopenedRepo.counterRepository.getCounter(SETUP.mintUrl, "0011223344556677"))?.counter).toBe(42);
    expect((await reopenedRepo.proofRepository.getReadyProofs(SETUP.mintUrl)).length).toBe(2);
    expect((await reopenedRepo.proofRepository.getInflightProofs()).length).toBe(1);
    expect((await reopenedRepo.proofRepository.getReservedProofs()).length).toBe(1);
    expect(reopened.sqlite.query("SELECT id FROM coco_cashu_migrations ORDER BY id").all()).toEqual(migrationIds);
    expect(reopened.sqlite.query("SELECT count(*) AS count FROM soi_migrations").get()).toEqual({ count: 2 });
  } finally {
    await reopenedWallet.dispose();
    reopened.close();
  }
});

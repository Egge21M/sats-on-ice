import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HDKey } from "@scure/bip32";
import { exportBackup } from "../src/backup.ts";
import { setupInstance, verifyInstance } from "../src/setup.ts";
import { inspectStatus } from "../src/status.ts";
import { startReceivingServer } from "../src/server.ts";
import { openDatabase } from "../src/storage/database.ts";
import { FIRST_ADDRESS, SECOND_ADDRESS, SETUP, XPUB } from "./fixtures.ts";
import { startMintFixture } from "./mint-fixture.ts";

let directory: string;
let database: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "soi-backup-")); database = join(directory, "wallet.sqlite"); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

// Compare every table, including migration histories, without logging secrets.
function digest(sqlite: Database) {
  const names = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  const rows = names.map(({ name }) => [name, sqlite.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
    .map((row) => JSON.stringify(row)).sort()]);
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(rows)).digest("hex");
}
function savedDigest(path: string) {
  const db = new Database(path, { readonly: true });
  try { return digest(db); } finally { db.close(); }
}

test("snapshot includes committed WAL state and all tables, excluding a concurrent uncommitted transaction", async () => {
  await setupInstance(database, SETUP);
  const writer = openDatabase(database, false);
  const output = join(directory, "backups", "owner's snapshot.sqlite");
  try {
    writer.sqlite.exec("PRAGMA wal_autocheckpoint = 0");
    writer.sqlite.exec("UPDATE soi_destination SET next_payout_index = 5");
    const committed = digest(writer.sqlite);
    expect(statSync(`${database}-wal`).size).toBeGreaterThan(0);
    writer.sqlite.exec("BEGIN IMMEDIATE");
    writer.sqlite.exec("UPDATE soi_destination SET next_payout_index = 6");
    writer.sqlite.exec("UPDATE soi_identity SET username = 'uncommitted'");
    const uncommitted = digest(writer.sqlite);
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      () => { throw new Error("Unexpected mint request"); }, { preconnect: () => {} },
    ));
    try {
      expect(exportBackup(database, output)).toBe(output);
      expect(savedDigest(output)).toBe(committed);
      expect(digest(writer.sqlite)).toBe(uncommitted);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); writer.sqlite.exec("ROLLBACK"); }
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "backups")).mode & 0o777).toBe(0o700);
    expect(existsSync(`${output}-wal`)).toBe(false);
    expect(readdirSync(join(directory, "backups"))).toEqual(["owner's snapshot.sqlite"]);
    expect((await verifyInstance(output, { mintUrl: SETUP.mintUrl, payoutThresholdSats: 1000 })).config)
      .toMatchObject({ username: "alice", nextPayoutIndex: 5 });
  } finally { writer.close(); }
});

test("backup never replaces existing destinations, aliases, or source journal paths", async () => {
  await setupInstance(database, SETUP);
  const output = join(directory, "existing.sqlite");
  const empty = join(directory, "empty.sqlite");
  const alias = join(directory, "alias.sqlite");
  const hardlink = join(directory, "hardlink.sqlite");
  const dangling = join(directory, "dangling.sqlite");
  writeFileSync(output, "preserve this backup");
  writeFileSync(empty, "");
  symlinkSync(database, alias);
  linkSync(database, hardlink);
  symlinkSync(join(directory, "missing.sqlite"), dangling);
  const before = savedDigest(database);
  for (const path of [output, empty, alias, hardlink, dangling, database, `${database}-wal`, `${database}-shm`, `${database}-journal`]) {
    expect(() => exportBackup(database, path)).toThrow(/already exists|separate path/);
  }
  expect(readFileSync(output, "utf8")).toBe("preserve this backup");
  expect(statSync(empty).size).toBe(0);
  expect(savedDigest(database)).toBe(before);
});

test("missing, invalid and inconsistent sources fail without publishing output or initializing state", async () => {
  const output = join(directory, "backup.sqlite");
  expect(() => exportBackup(database, output)).toThrow("Unable to export backup");
  expect(existsSync(database)).toBe(false);
  writeFileSync(database, "not a database; private material");
  expect(() => exportBackup(database, output)).toThrow("Unable to export backup");
  expect(existsSync(output)).toBe(false);
  rmSync(database);
  await setupInstance(database, SETUP);
  const broken = new Database(database);
  broken.exec("PRAGMA foreign_keys = OFF");
  broken.exec("UPDATE soi_active_identity SET identity_id = 999");
  broken.close();
  expect(() => exportBackup(database, output)).toThrow("integrity checks");
  expect(existsSync(output)).toBe(false);
  expect(readdirSync(directory).some((name) => name.startsWith(".soi-backup-"))).toBe(false);
});

test("live export restores ecash, pending payouts, quotes, identities and counters through the existing lifecycle", async () => {
  const old = startMintFixture();
  const current = startMintFixture();
  old.state.pendingPayouts = true;
  current.state.pendingPayouts = true;
  const otherKey = HDKey.fromMasterSeed(new Uint8Array(32).fill(3)).derive("m/84'/0'/0'").publicExtendedKey;
  const original = { ...SETUP, mintUrl: old.url, payoutThresholdSats: 1000 };
  const selected = { ...original, username: "carol", destinationKey: otherKey, mintUrl: current.url };
  const policy = { mintUrl: current.url, payoutThresholdSats: 1000 };
  const timing = { pollingIntervalMs: 500, processorIntervalMs: 20 };
  let service: Awaited<ReturnType<typeof startReceivingServer>> | undefined;
  async function eventually(check: () => Promise<boolean>) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(40); }
    throw new Error("Timed out waiting for controlled wallet activity");
  }
  async function invoice(username: string, amount: number) {
    const response = await fetch(`http://127.0.0.1:${service!.port}/lnurlp/${username}/callback?amount=${amount * 1000}`);
    expect(response.status).toBe(200);
    return (await response.json() as { pr: string }).pr;
  }
  try {
    service = await startReceivingServer({ database, config: original, port: 0, timing });
    old.pay(await invoice("alice", 1000));
    await eventually(async () => (await inspectStatus(database, original)).mints[0]?.payouts[0]?.state === "pending");
    old.pay(await invoice("alice", 400));
    await eventually(async () => (await verifyInstance(database, original)).accumulatedBalanceSats === "400");
    await service.stop(); service = undefined;
    await setupInstance(database, { ...original, username: "bob" }); // Same destination and counter.
    service = await startReceivingServer({ database, config: selected, port: 0, timing });
    current.pay(await invoice("carol", 1000));
    await eventually(async () => (await inspectStatus(database, selected)).mints.find((m) => m.selected)?.payouts[0]?.state === "pending");
    current.pay(await invoice("carol", 200));
    await eventually(async () => (await verifyInstance(database, selected)).accumulatedBalanceSats === "200");
    const unpaid = await invoice("carol", 11);
    const before = savedDigest(database);
    const backup = join(directory, "backup.sqlite");
    // A separate CLI process reads while the live server owns its wallet manager.
    const child = Bun.spawn([process.execPath, new URL("../index.ts", import.meta.url).pathname, "--database", database, "backup", backup], {
      env: { ...process.env, SOI_MINT_URL: undefined, SOI_PAYOUT_THRESHOLD_SATS: undefined, SOI_USERNAME: undefined, SOI_XPUB: undefined },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Backup saved");
    expect(savedDigest(backup)).toBe(before);
    await service.stop(); service = undefined;

    // Keep the original and immutable backup; restore into a different work file.
    const restored = join(directory, "restored.sqlite");
    copyFileSync(backup, restored);
    const offline = await inspectStatus(restored, policy);
    expect(offline.live).toBeNull();
    expect(offline.lastActiveIdentity).toMatchObject({ username: "carol", nextPayoutIndex: 1 });
    expect(offline.nextStart).toMatchObject({ username: "carol", destinationKey: otherKey, nextPayoutIndex: 1 });
    expect(offline.mints.find((m) => m.mintUrl === old.url)).toMatchObject({ spendableSats: "400", reservedForPayoutsSats: "1000" });
    expect(offline.mints.find((m) => m.selected)).toMatchObject({ spendableSats: "200", reservedForPayoutsSats: "1000", pendingReceivingQuotes: 1 });
    expect(savedDigest(restored)).toBe(before); // Inspection did not advance payments.
    expect(old.state.meltRequests).toBe(1);
    expect(current.state.meltRequests).toBe(1);

    old.settle(old.submissions[0]!.quote.quote);
    current.settle(current.submissions[0]!.quote.quote);
    current.pay(unpaid);
    service = await startReceivingServer({ database: restored, config: policy, port: 0, timing });
    await eventually(async () => (await verifyInstance(restored, policy)).accumulatedBalanceSats === "214" &&
      (await verifyInstance(restored, original)).accumulatedBalanceSats === "403");
    expect(old.state.meltRequests).toBe(1);
    expect(current.state.meltRequests).toBe(1);
    expect(old.submissions[0]!.quote.request).toBe(FIRST_ADDRESS);
    expect((await verifyInstance(restored, { ...original, username: "bob" })).config).toMatchObject({ nextPayoutIndex: 1, destinationKey: XPUB });
    const seedDigest = (path: string) => {
      const db = new Database(path, { readonly: true });
      try { return new Bun.CryptoHasher("sha256").update((db.query("SELECT seed FROM soi_wallet_secret").get() as { seed: Uint8Array }).seed).digest("hex"); }
      finally { db.close(); }
    };
    expect(seedDigest(restored)).toBe(seedDigest(backup));
    await service.stop(); service = undefined;
    old.state.pendingPayouts = false;
    service = await startReceivingServer({ database: restored, config: original, port: 0, timing });
    expect((await verifyInstance(restored, original)).config.nextPayoutIndex).toBe(1);
    old.pay(await invoice("alice", 600));
    await eventually(async () => (await verifyInstance(restored, original)).accumulatedBalanceSats === "3");
    expect(old.submissions[1]!.quote.request).toBe(SECOND_ADDRESS);
    expect((await verifyInstance(restored, original)).config.nextPayoutIndex).toBe(2);
    expect((await verifyInstance(restored, selected)).config.nextPayoutIndex).toBe(1);
    expect(current.state.meltRequests).toBe(1); // No new sweep at the previous mint.
    expect(savedDigest(backup)).toBe(before);
  } finally { await service?.stop(); await old.stop(); await current.stop(); }
}, 60_000);

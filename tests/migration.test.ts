import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Amount } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupInstance, verifyInstance } from "../src/setup.ts";
import { openDatabase } from "../src/storage/database.ts";
import { InstanceStore } from "../src/storage/instance-store.ts";
import { derivePayoutAddress } from "../src/destination.ts";
import { SETUP, XPUB } from "./fixtures.ts";
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "soi-migration-")); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

for (const nextIndex of [7, 0x80000000]) {
  test(`migrates the old singleton schema with index ${nextIndex} without changing Coco or its seed`, async () => {
    const migrations = join(directory, "legacy");
    mkdirSync(join(migrations, "meta"), { recursive: true });
    copyFileSync(new URL("../drizzle/0000_initial_setup.sql", import.meta.url), join(migrations, "0000_initial_setup.sql"));
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    writeFileSync(join(migrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    const path = join(directory, "wallet.sqlite");
    const legacy = new Database(path);
    migrate(drizzle(legacy), { migrationsFolder: migrations, migrationsTable: "soi_migrations" });
    const seed = new Uint8Array(64).fill(7); // Public test material only.
    legacy.query("INSERT INTO soi_wallet_secret (id, seed) VALUES (1, ?)").run(seed);
    legacy.query("INSERT INTO soi_identity (id, username, destination_key, next_payout_index) VALUES (1, ?, ?, ?)").run("alice", XPUB, nextIndex);
    legacy.query("INSERT INTO soi_settings (key, value) VALUES (?, ?)").run("mintUrl", JSON.stringify(SETUP.mintUrl));
    legacy.query("INSERT INTO soi_settings (key, value) VALUES (?, ?)").run("payoutThresholdSats", "100000");
    const repo = new SqliteRepositories({ database: legacy });
    await repo.init();
    await repo.counterRepository.setCounter(SETUP.mintUrl, "0011223344556677", 42);
    await repo.proofRepository.saveProofs(SETUP.mintUrl, [{ id: "0011223344556677", mintUrl: SETUP.mintUrl,
      amount: Amount.from(4), unit: "sat", secret: "public-migration-proof", C: "02" + "11".repeat(32), state: "ready" }]);
    const cocoMigrations = legacy.query("SELECT * FROM coco_cashu_migrations").all();
    legacy.close();

    const input = { mintUrl: "https://new.example", payoutThresholdSats: 10 };
    const result = await setupInstance(path, input);
    expect(result.config).toEqual({ ...input, username: "alice", destinationKey: XPUB, identityId: 1, destinationId: 1, nextPayoutIndex: nextIndex });
    expect(result.accumulatedBalanceSats).toBe("0");
    expect((await verifyInstance(path, { ...input, mintUrl: SETUP.mintUrl })).accumulatedBalanceSats).toBe("4");
    const connection = openDatabase(path, false);
    try {
      const store = new InstanceStore(connection.db);
      expect(Buffer.from(store.getSeed()).equals(Buffer.from(seed))).toBe(true);
      expect(connection.sqlite.query("SELECT * FROM coco_cashu_migrations").all()).toEqual(cocoMigrations);
      expect(connection.sqlite.query("SELECT COUNT(*) AS count FROM soi_migrations").get()).toEqual({ count: 2 });
      expect(connection.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'soi_settings'").all()).toEqual([]);
      expect(connection.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const reopened = new SqliteRepositories({ database: connection.sqlite });
      await reopened.init();
      expect((await reopened.counterRepository.getCounter(SETUP.mintUrl, "0011223344556677"))?.counter).toBe(42);
      const allocate = () => connection.sqlite.transaction(() => store.allocatePayout(result.config.destinationId)).immediate();
      if (nextIndex === 0x80000000) expect(allocate).toThrow("Payout index");
      else expect(allocate()).toEqual({ index: nextIndex, address: derivePayoutAddress(XPUB, nextIndex) });
    } finally { connection.close(); }
    const again = await setupInstance(path, input);
    expect(again.config.nextPayoutIndex).toBe(nextIndex === 0x80000000 ? nextIndex : nextIndex + 1);
  });
}

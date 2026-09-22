import { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrateApplication } from "../../migrations.ts";
import { UserError } from "../errors.ts";
import * as schema from "./schema.ts";

export function openDatabase(path: string, create: boolean) {
  if (!path.trim() || path === ":memory:") throw new UserError("Choose a persistent SQLite database path.");
  const filename = resolve(path);
  if (create) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(filename, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  let sqlite: Database;
  try {
    // Tighten permissions before putting secrets into the database or WAL.
    chmodSync(filename, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      try { chmodSync(`${filename}${suffix}`, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    sqlite = new Database(filename, { create: false, strict: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UserError("Database not found. Run setup first with the same --database path.");
    }
    throw error;
  }
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("PRAGMA journal_mode = WAL");
    const db = drizzle({ client: sqlite, schema });
    migrateApplication(db);
    return { sqlite, db, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type AppDatabase = ReturnType<typeof openDatabase>["db"];

/** Status never creates a file, changes permissions, or applies either migration system. */
export function openInspectionDatabase(path: string) {
  if (!path.trim() || path === ":memory:") throw new UserError("Choose a persistent SQLite database path.");
  let sqlite: Database;
  try { sqlite = new Database(resolve(path), { readonly: true, strict: true }); }
  catch { throw new UserError("Unable to read the database. Check the path and permissions; run setup or serve to initialize it first."); }
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const tables = new Set((sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    if (!["soi_destination", "soi_identity", "soi_active_identity", "soi_wallet_secret"].every((name) => tables.has(name))) {
      throw new UserError("Local status requires initialized application repositories. Run setup or serve to initialize or upgrade this database; status applies no migrations.");
    }
    return { sqlite, db: drizzle({ client: sqlite, schema }), close: () => sqlite.close() };
  } catch (error) { sqlite.close(); throw error; }
}

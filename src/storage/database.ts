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

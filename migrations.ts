import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

/** This root module and the bundled entry both sit alongside their SQL folder. */
export function migrateApplication<TSchema extends Record<string, unknown>>(db: BunSQLiteDatabase<TSchema>) {
  migrate(db, {
    migrationsFolder: fileURLToPath(new URL("./drizzle/", import.meta.url)),
    migrationsTable: "soi_migrations",
  });
}

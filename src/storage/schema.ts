import { sql } from "drizzle-orm";
import { blob, check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("soi_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
}, (table) => [check("soi_settings_json", sql`json_valid(${table.value})`)]);

export const identity = sqliteTable("soi_identity", {
  id: integer("id").primaryKey(),
  username: text("username").notNull().unique(),
  destinationKey: text("destination_key").notNull(),
  nextPayoutIndex: integer("next_payout_index").notNull().default(0),
}, (table) => [
  check("soi_identity_singleton", sql`${table.id} = 1`),
  check("soi_identity_index", sql`typeof(${table.nextPayoutIndex}) = 'integer' AND ${table.nextPayoutIndex} BETWEEN 0 AND 2147483648`),
]);

// Seed material is deliberately separate from displayable instance settings.
export const walletSecret = sqliteTable("soi_wallet_secret", {
  id: integer("id").primaryKey(),
  seed: blob("seed", { mode: "buffer" }).notNull(),
}, (table) => [
  check("soi_wallet_secret_singleton", sql`${table.id} = 1`),
  check("soi_wallet_secret_length", sql`typeof(${table.seed}) = 'blob' AND length(${table.seed}) = 64`),
]);

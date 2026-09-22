import { sql } from "drizzle-orm";
import { blob, check, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const destination = sqliteTable("soi_destination", {
  id: integer("id").primaryKey(),
  xpub: text("xpub").notNull().unique(),
  nextPayoutIndex: integer("next_payout_index").notNull().default(0),
}, (table) => [
  check("soi_destination_index", sql`typeof(${table.nextPayoutIndex}) = 'integer' AND ${table.nextPayoutIndex} BETWEEN 0 AND 2147483648`),
]);

export const identity = sqliteTable("soi_identity", {
  id: integer("id").primaryKey(),
  username: text("username").notNull(),
  destinationId: integer("destination_id").notNull().references(() => destination.id),
}, (table) => [
  unique("soi_identity_username_destination_unique").on(table.username, table.destinationId),
]);

export const activeIdentity = sqliteTable("soi_active_identity", {
  id: integer("id").primaryKey(),
  identityId: integer("identity_id").notNull().references(() => identity.id),
}, (table) => [check("soi_active_identity_singleton", sql`${table.id} = 1`)]);

// Seed material is deliberately separate from displayable instance settings.
export const walletSecret = sqliteTable("soi_wallet_secret", {
  id: integer("id").primaryKey(),
  seed: blob("seed", { mode: "buffer" }).notNull(),
}, (table) => [
  check("soi_wallet_secret_singleton", sql`${table.id} = 1`),
  check("soi_wallet_secret_length", sql`typeof(${table.seed}) = 'blob' AND length(${table.seed}) = 64`),
]);

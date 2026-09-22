import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { and, eq } from "drizzle-orm";
import { activeConfigSchema, type ActiveConfig, type RuntimeConfig } from "../config.ts";
import { UserError } from "../errors.ts";
import { derivePayoutAddress } from "../destination.ts";
import type { AppDatabase } from "./database.ts";
import { activeIdentity, destination, identity, walletSecret } from "./schema.ts";

export class InstanceStore {
  constructor(private readonly db: AppDatabase) {}

  /** Caller holds an IMMEDIATE transaction; allocate against the server's selected destination. */
  allocatePayout(destinationId: number) {
    const row = this.db.select().from(destination).where(eq(destination.id, destinationId)).get();
    if (!row) throw new UserError("Payout destination is missing.");
    const address = derivePayoutAddress(row.xpub, row.nextPayoutIndex);
    this.db.update(destination).set({ nextPayoutIndex: row.nextPayoutIndex + 1 }).where(eq(destination.id, row.id)).run();
    return { address, index: row.nextPayoutIndex };
  }

  private identityQuery() {
    return this.db.select({
      identityId: identity.id, username: identity.username,
      destinationId: destination.id, destinationKey: destination.xpub,
      nextPayoutIndex: destination.nextPayoutIndex,
    }).from(identity).innerJoin(destination, eq(identity.destinationId, destination.id));
  }

  private currentIdentity() {
    const active = this.db.select().from(activeIdentity).where(eq(activeIdentity.id, 1)).get();
    return active ? this.identityQuery().where(eq(identity.id, active.identityId)).get() : undefined;
  }

  private requestedIdentity(input: RuntimeConfig) {
    const current = this.currentIdentity();
    const username = input.username ?? current?.username;
    const destinationKey = input.destinationKey ?? current?.destinationKey;
    if (!username || !destinationKey) {
      throw new UserError("Set SOI_USERNAME and SOI_XPUB for the first startup.");
    }
    return { username, destinationKey };
  }

  private configured(input: RuntimeConfig, row: NonNullable<ReturnType<InstanceStore["currentIdentity"]>>): ActiveConfig {
    // Validate stored identity data without including it in error output.
    const parsed = activeConfigSchema.safeParse({ ...input, ...row });
    if (!parsed.success) throw new UserError("Stored identity or destination is invalid. Restore valid instance state.");
    return parsed.data;
  }

  /** Read the env-selected identity without creating or activating records. */
  load(input: RuntimeConfig): ActiveConfig {
    this.getSeed();
    if (!this.currentIdentity()) throw new UserError("Stored instance is incomplete. Restore the complete database.");
    const requested = this.requestedIdentity(input);
    const row = this.identityQuery().where(and(eq(identity.username, requested.username), eq(destination.xpub, requested.destinationKey))).get();
    if (!row) throw new UserError("Configured identity has not been initialized. Run setup or serve first.");
    return this.configured(input, row);
  }

  getSeed(): Uint8Array {
    const row = this.db.select({ seed: walletSecret.seed }).from(walletSecret).where(eq(walletSecret.id, 1)).get();
    if (!row || row.seed.length !== 64) throw new UserError("The stored Cashu seed is missing or invalid. Restore the complete database.");
    return Uint8Array.from(row.seed);
  }

  /** Caller holds an IMMEDIATE transaction for seed creation and identity selection. */
  initialize(input: RuntimeConfig, hasCocoSchema: boolean): { created: boolean; config: ActiveConfig } {
    const secret = this.db.select().from(walletSecret).get();
    if (secret) {
      this.getSeed();
      if (!this.currentIdentity()) throw new UserError("Stored instance is incomplete. Restore the complete database.");
    } else if (hasCocoSchema || this.db.select().from(identity).get() ||
        this.db.select().from(destination).get() || this.db.select().from(activeIdentity).get()) {
      throw new UserError("Existing wallet state has no Cashu seed; a replacement seed will not be generated. Restore the complete database.");
    }
    const requested = this.requestedIdentity(input);
    let target = this.db.select().from(destination).where(eq(destination.xpub, requested.destinationKey)).get();
    if (!target) target = this.db.insert(destination).values({ xpub: requested.destinationKey }).returning().get();
    let selected = this.db.select().from(identity).where(and(eq(identity.username, requested.username), eq(identity.destinationId, target.id))).get();
    const created = !selected;
    if (!selected) selected = this.db.insert(identity).values({ username: requested.username, destinationId: target.id }).returning().get();
    this.db.insert(activeIdentity).values({ id: 1, identityId: selected.id })
      .onConflictDoUpdate({ target: activeIdentity.id, set: { identityId: selected.id } }).run();
    if (!secret) {
      const seed = Buffer.from(mnemonicToSeedSync(generateMnemonic(wordlist, 256)));
      try { this.db.insert(walletSecret).values({ id: 1, seed }).run(); }
      finally { seed.fill(0); }
    }
    return { created, config: this.load(input) };
  }
}

import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { eq } from "drizzle-orm";
import { storedConfigSchema, type SetupInput, type StoredConfig } from "../config.ts";
import { UserError } from "../errors.ts";
import type { AppDatabase } from "./database.ts";
import { identity, settings, walletSecret } from "./schema.ts";

export class ConfigStore {
  constructor(private readonly db: AppDatabase) {}

  load(): StoredConfig | null {
    const rows = this.db.select().from(settings).all();
    const identities = this.db.select().from(identity).all();
    const secrets = this.db.select({ id: walletSecret.id }).from(walletSecret).all();
    if (!rows.length && !identities.length && !secrets.length) return null;
    if (identities.length !== 1 || secrets.length !== 1) {
      throw new UserError("Stored setup is incomplete. Restore the complete database; setup will not replace missing wallet state.");
    }
    try {
      const values = Object.fromEntries(rows.map(({ key, value }) => [key, JSON.parse(value)]));
      const storedIdentity = identities[0]!;
      const config = storedConfigSchema.parse({
        username: storedIdentity.username,
        destinationKey: storedIdentity.destinationKey,
        nextPayoutIndex: storedIdentity.nextPayoutIndex,
        mintUrl: values.mintUrl,
        payoutThresholdSats: values.payoutThresholdSats,
      });
      // Validate the seed too, but never include it in returned configuration.
      this.getSeed();
      return config;
    } catch {
      throw new UserError("Stored configuration or seed is invalid. Restore a complete valid database; existing data was not replaced.");
    }
  }

  getSeed(): Uint8Array {
    const row = this.db.select({ seed: walletSecret.seed }).from(walletSecret).where(eq(walletSecret.id, 1)).get();
    if (!row || row.seed.length !== 64) throw new UserError("The stored Cashu seed is missing or invalid.");
    return Uint8Array.from(row.seed);
  }

  /** The caller holds an IMMEDIATE transaction for the entire check and insert. */
  initialize(input: SetupInput, hasCocoSchema: boolean): boolean {
    const existing = this.load();
    if (existing) {
      const changed = (Object.keys(input) as (keyof SetupInput)[]).filter((key) => input[key] !== existing[key]);
      if (changed.length) {
        throw new UserError(`Setup already exists with different ${changed.join(", ")}. Setup does not overwrite settings; mint and destination key are fixed for this wallet.`);
      }
      return false;
    }
    if (hasCocoSchema) {
      throw new UserError("Coco wallet tables already exist without complete application state. Restore the complete database; a replacement seed will not be generated.");
    }
    const seed = Buffer.from(mnemonicToSeedSync(generateMnemonic(wordlist, 256)));
    try {
      this.db.insert(walletSecret).values({ id: 1, seed }).run();
      this.db.insert(settings).values([
        { key: "mintUrl", value: JSON.stringify(input.mintUrl) },
        { key: "payoutThresholdSats", value: JSON.stringify(input.payoutThresholdSats) },
      ]).run();
      this.db.insert(identity).values({
        id: 1,
        username: input.username,
        destinationKey: input.destinationKey,
        nextPayoutIndex: 0,
      }).run();
      return true;
    } finally {
      seed.fill(0);
    }
  }
}

import { setupSchema, type StoredConfig } from "./config.ts";
import { derivePayoutAddress } from "./destination.ts";
import { UserError } from "./errors.ts";
import { ConfigStore } from "./storage/config-store.ts";
import { openDatabase } from "./storage/database.ts";
import { assertConfiguredMint, openLocalWallet } from "./wallet.ts";

export interface SetupSummary {
  created: boolean;
  config: StoredConfig;
  firstPayoutAddress: string;
  accumulatedBalanceSats: string;
}

async function inspect(connection: ReturnType<typeof openDatabase>, store: ConfigStore, created: boolean): Promise<SetupSummary> {
  const config = connection.sqlite.transaction(() => store.load())();
  if (!config) throw new UserError("This database has not been set up. Run setup first.");
  const wallet = await openLocalWallet(connection.sqlite, async () => store.getSeed());
  try {
    await assertConfiguredMint(wallet, config.mintUrl);
    const balance = await wallet.wallet.balances.total({ mintUrls: [config.mintUrl], units: ["sat"] });
    return {
      created,
      config,
      firstPayoutAddress: derivePayoutAddress(config.destinationKey, 0),
      accumulatedBalanceSats: balance.spendable.toString(),
    };
  } finally {
    await wallet.dispose();
  }
}

export async function setupInstance(path: string, input: unknown): Promise<SetupSummary> {
  // Invalid input must not create a database or seed.
  const config = setupSchema.parse(input);
  const connection = openDatabase(path, true);
  try {
    const store = new ConfigStore(connection.db);
    const created = connection.sqlite.transaction(() => {
      const hasCocoSchema = !!connection.sqlite.query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name GLOB 'coco_cashu_*' LIMIT 1",
      ).get();
      return store.initialize(config, hasCocoSchema);
    }).immediate();
    return await inspect(connection, store, created);
  } finally {
    connection.close();
  }
}

export async function verifyInstance(path: string): Promise<SetupSummary> {
  const connection = openDatabase(path, false);
  try {
    return await inspect(connection, new ConfigStore(connection.db), false);
  } finally {
    connection.close();
  }
}

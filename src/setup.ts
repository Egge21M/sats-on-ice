import { setupSchema, type StoredConfig } from "./config.ts";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { derivePayoutAddress } from "./destination.ts";
import { UserError } from "./errors.ts";
import { assertConfiguredMint, ConfigStore } from "./storage/config-store.ts";
import { openDatabase } from "./storage/database.ts";

export interface SetupSummary {
  created: boolean;
  config: StoredConfig;
  firstPayoutAddress: string;
  accumulatedBalanceSats: string;
}

async function inspect(connection: ReturnType<typeof openDatabase>, store: ConfigStore, created: boolean): Promise<SetupSummary> {
  const config = connection.sqlite.transaction(() => store.load())();
  if (!config) throw new UserError("This database has not been set up. Run setup first.");
  const repo = new SqliteRepositories({ database: connection.sqlite });
  await repo.init();
  await assertConfiguredMint(repo, config.mintUrl);
  const proofs = await repo.proofRepository.getAvailableProofs(config.mintUrl, { unit: "sat" });
  const balance = proofs.reduce((sum, proof) => sum + proof.amount.toBigInt(), 0n);
  return {
    created,
    config,
    firstPayoutAddress: derivePayoutAddress(config.destinationKey, 0),
    accumulatedBalanceSats: balance.toString(),
  };
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

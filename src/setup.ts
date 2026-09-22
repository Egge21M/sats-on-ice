import { readRuntimeConfig, runtimeConfigSchema, type ActiveConfig } from "./config.ts";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { derivePayoutAddress } from "./destination.ts";
import { InstanceStore } from "./storage/instance-store.ts";
import { openDatabase } from "./storage/database.ts";

export interface SetupSummary {
  created: boolean;
  config: ActiveConfig;
  firstPayoutAddress: string;
  accumulatedBalanceSats: string;
}

/** Initialize/select local state before any mint requests; the caller owns close(). */
export function openInstance(path: string, input: unknown = readRuntimeConfig()) {
  const parsed = runtimeConfigSchema.parse(input);
  const connection = openDatabase(path, true);
  try {
    const store = new InstanceStore(connection.db);
    const selected = connection.sqlite.transaction(() => {
      const hasCocoSchema = !!connection.sqlite.query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name GLOB 'coco_cashu_*' LIMIT 1",
      ).get();
      return store.initialize(parsed, hasCocoSchema);
    }).immediate();
    return { ...connection, store, ...selected };
  } catch (error) {
    connection.close();
    throw error;
  }
}

async function inspect(connection: ReturnType<typeof openDatabase>, config: ActiveConfig, created: boolean): Promise<SetupSummary> {
  const repo = new SqliteRepositories({ database: connection.sqlite });
  await repo.init();
  const proofs = await repo.proofRepository.getAvailableProofs(config.mintUrl, { unit: "sat" });
  const balance = proofs.reduce((sum, proof) => sum + proof.amount.toBigInt(), 0n);
  return {
    created, config,
    firstPayoutAddress: derivePayoutAddress(config.destinationKey, 0),
    accumulatedBalanceSats: balance.toString(),
  };
}

export async function setupInstance(path: string, input: unknown = readRuntimeConfig()): Promise<SetupSummary> {
  const connection = openInstance(path, input);
  try { return await inspect(connection, connection.config, connection.created); }
  finally { connection.close(); }
}

export async function verifyInstance(path: string, input: unknown = readRuntimeConfig()): Promise<SetupSummary> {
  const parsed = runtimeConfigSchema.parse(input);
  const connection = openDatabase(path, false);
  try {
    const config = connection.sqlite.transaction(() => new InstanceStore(connection.db).load(parsed))();
    return await inspect(connection, config, false);
  } finally { connection.close(); }
}

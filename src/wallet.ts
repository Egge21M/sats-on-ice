import { Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import type { Database } from "bun:sqlite";
import { UserError } from "./errors.ts";

export async function assertConfiguredMint(wallet: Manager, mintUrl: string) {
  const mints = await wallet.mint.getAllMints();
  const balances = await wallet.wallet.balances.byMintAndUnit();
  if (mints.some((mint) => mint.mintUrl !== mintUrl) || Object.keys(balances).some((mint) => mint !== mintUrl)) {
    throw new UserError("This wallet contains a different mint from its configured mint. Restore the matching application and wallet state.");
  }
}

/** Local inspection only: do not run startup recovery or background workers. */
export async function openLocalWallet(sqlite: Database, seedGetter: () => Promise<Uint8Array>) {
  const repo = new SqliteRepositories({ database: sqlite });
  await repo.init();
  // initializeCoco() also resumes persisted operations even with workers disabled.
  // The receiving wallet owns that active lifecycle separately.
  const manager = new Manager(repo, seedGetter);
  try {
    await manager.initPlugins();
    return manager;
  } catch (error) {
    await manager.dispose();
    throw error;
  }
}

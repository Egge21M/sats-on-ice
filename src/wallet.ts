import { Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import type { Database } from "bun:sqlite";

/** Local inspection only: do not run startup recovery or background workers. */
export async function openLocalWallet(sqlite: Database, seedGetter: () => Promise<Uint8Array>) {
  const repo = new SqliteRepositories({ database: sqlite });
  await repo.init();
  // initializeCoco() also resumes persisted operations even with workers disabled.
  // The server slice will own that active lifecycle separately.
  const manager = new Manager(repo, seedGetter);
  try {
    await manager.initPlugins();
    return manager;
  } catch (error) {
    await manager.dispose();
    throw error;
  }
}

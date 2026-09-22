import { Manager } from "@cashu/coco-core";
import type { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { UserError } from "./errors.ts";

export async function assertConfiguredMint(repo: SqliteRepositories, mintUrl: string) {
  const mints = await repo.mintRepository.getAllMints();
  const proofs = await repo.proofRepository.getAllReadyProofs();
  if (mints.some((mint) => mint.mintUrl !== mintUrl) || proofs.some((proof) => proof.mintUrl !== mintUrl)) {
    throw new UserError("This wallet contains a different mint from its configured mint. Restore the matching application and wallet state.");
  }
}

/** Local inspection only: do not run startup recovery or background workers. */
export async function openLocalWallet(repo: SqliteRepositories, seedGetter: () => Promise<Uint8Array>) {
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

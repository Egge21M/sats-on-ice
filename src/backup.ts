import { Database } from "bun:sqlite";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { UserError } from "./errors.ts";

/** Copy every table in one SQLite snapshot without migrations or payment recovery. */
export function exportBackup(database: string, output: string): string {
  if (!database.trim() || database === ":memory:" || !output.trim() || output === ":memory:") {
    throw new UserError("Choose persistent database and backup file paths.");
  }
  const filename = resolve(output);
  let source: Database | undefined;
  let staging: string | undefined;
  try {
    // Read-only opening cannot initialize a missing database or replace its seed.
    const sourcePath = realpathSync(database);
    source = new Database(sourcePath, { readonly: true, strict: true });
    source.exec("PRAGMA busy_timeout = 5000");
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const target = join(realpathSync(dirname(filename)), basename(filename));
    if (["", "-wal", "-shm", "-journal"].some((suffix) => target === `${sourcePath}${suffix}`)) {
      throw new UserError("The backup must use a separate path from the database and its SQLite journal files.");
    }
    try {
      lstatSync(filename); // Reject even empty files and dangling symlinks.
      throw new UserError("Backup destination already exists. Choose a new file; existing backups are never overwritten.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Keep incomplete output private and on the destination filesystem. A crash
    // may leave this directory, but never a partial file at the requested path.
    staging = mkdtempSync(join(dirname(filename), ".soi-backup-"));
    const temporary = join(staging, "snapshot.sqlite");
    const fd = openSync(temporary, "wx", 0o600);
    try {
      source.query("VACUUM INTO ?").run(temporary);
      const snapshot = new Database(temporary, { readonly: true, strict: true });
      try {
        const checks = snapshot.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
        if (checks.length !== 1 || checks[0]?.integrity_check !== "ok" || snapshot.query("PRAGMA foreign_key_check").get()) {
          throw new UserError("Backup failed SQLite integrity checks. Preserve the original database and investigate before restoring.");
        }
      } finally { snapshot.close(); }
      fsyncSync(fd);
      // An atomic hard link publishes the completed snapshot without replacing
      // a destination created by another exporter while VACUUM was running.
      linkSync(temporary, filename);
      const parent = openSync(dirname(filename), "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { closeSync(fd); }
    return filename;
  } catch (error) {
    if (error instanceof UserError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UserError("Backup destination already exists. Choose a new file; existing backups are never overwritten.");
    }
    // SQLite errors can contain private wallet data; do not include their text.
    throw new UserError("Unable to export backup. Check the existing database, destination permissions, free space and SQLite locks. Use a new output path when retrying.");
  } finally {
    source?.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

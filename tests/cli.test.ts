import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/storage/config-store.ts";
import { openDatabase } from "../src/storage/database.ts";
import { FIRST_ADDRESS, ZPUB } from "./fixtures.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "sats-on-ice-cli-")); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const entry = new URL("../index.ts", import.meta.url).pathname;

async function cli(...args: string[]) {
  const process = Bun.spawn([Bun.which("bun")!, entry, ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  return { stdout, stderr, code };
}

test("help, setup and verify work from another directory and exit without background workers", async () => {
  const help = await cli("--help");
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("setup");
  expect(help.stdout).toContain("verify");
  const path = join(directory, "owner.sqlite");
  const setup = await cli("--database", path, "setup", "--username", "alice", "--mint", "https://mint.example", "--xpub", ZPUB, "--threshold", "100000");
  expect(setup.code).toBe(0);
  expect(setup.stderr).toBe("");
  expect(setup.stdout).toContain(FIRST_ADDRESS);
  expect(setup.stdout).toContain("Accumulated balance: 0 sats");
  const verify = await cli("--database", path, "verify");
  expect(verify.code).toBe(0);
  expect(verify.stdout).toContain("Existing setup verified");
  const connection = openDatabase(path, false);
  try {
    const seed = Buffer.from(new ConfigStore(connection.db).getSeed());
    // Boolean assertions prevent a regression from printing the seed in test output.
    expect((setup.stdout + setup.stderr + verify.stdout + verify.stderr).includes(seed.toString("hex"))).toBe(false);
    expect((setup.stdout + setup.stderr + verify.stdout + verify.stderr).includes(seed.toString("base64"))).toBe(false);
  } finally {
    connection.close();
  }
}, 10_000);

test("invalid setup exits nonzero without echoing key material or library traces", async () => {
  const badKey = "xprv-do-not-echo-this-input";
  const result = await cli("setup", "--username", "alice", "--mint", "https://mint.example", "--xpub", badKey, "--threshold", "1000");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Invalid configuration");
  expect(result.stderr.includes(badKey)).toBe(false);
  expect(result.stdout).toBe("");
});

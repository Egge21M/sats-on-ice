import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceStore } from "../src/storage/instance-store.ts";
import { openDatabase } from "../src/storage/database.ts";
import { FIRST_ADDRESS, ZPUB } from "./fixtures.ts";

let directory: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sats-on-ice-cli-"));
  env = { ...process.env, SOI_DATABASE: join(directory, "owner.sqlite"), SOI_USERNAME: "alice", SOI_XPUB: ZPUB,
    SOI_MINT_URL: "https://mint.example", SOI_PAYOUT_THRESHOLD_SATS: "100000" };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const entry = new URL("../index.ts", import.meta.url).pathname;
async function cli(...args: string[]) {
  const child = Bun.spawn([Bun.which("bun")!, entry, ...args], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("env-driven setup and verify work from another directory and omit seed material", async () => {
  expect((await cli("--help")).stdout).toContain("serve");
  const setup = await cli("setup");
  expect(setup.code).toBe(0);
  expect(setup.stderr).toBe("");
  expect(setup.stdout).toContain(FIRST_ADDRESS);
  expect(setup.stdout).toContain("Accumulated balance: 0 sats");
  delete env.SOI_USERNAME;
  delete env.SOI_XPUB;
  const verify = await cli("verify");
  expect(verify.code).toBe(0);
  expect(verify.stdout).toContain("Username: alice");
  const connection = openDatabase(env.SOI_DATABASE!, false);
  try {
    const seed = Buffer.from(new InstanceStore(connection.db).getSeed());
    expect((setup.stdout + setup.stderr + verify.stdout + verify.stderr).includes(seed.toString("hex"))).toBe(false);
    expect((setup.stdout + setup.stderr + verify.stdout + verify.stderr).includes(seed.toString("base64"))).toBe(false);
  } finally { connection.close(); }
}, 10_000);

test("invalid environment exits without echoing key material or creating a database", async () => {
  const badKey = "xprv-do-not-echo-this-input";
  env.SOI_XPUB = badKey;
  const result = await cli("setup");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Invalid configuration");
  expect(result.stderr.includes(badKey)).toBe(false);
  expect(result.stdout).toBe("");
  expect(existsSync(env.SOI_DATABASE!)).toBe(false);
});

test("serve rejects invalid ports and missing runtime policy before creating state", async () => {
  for (const port of ["-1", "65536", "3000oops", "1.5"]) expect((await cli("serve", "--port", port)).code).toBe(1);
  expect(existsSync(env.SOI_DATABASE!)).toBe(false);
  delete env.SOI_MINT_URL;
  const missing = await cli("serve");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("SOI_MINT_URL");
  expect(existsSync(env.SOI_DATABASE!)).toBe(false);
});

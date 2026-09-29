import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startReceivingServer } from "../src/server.ts";
import { initializeCoco } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { openInstance } from "../src/setup.ts";
import { inspectStatus } from "../src/status.ts";
import { SETUP, FIRST_ADDRESS, SECOND_ADDRESS } from "./fixtures.ts";
import { startMintFixture } from "./mint-fixture.ts";

let directory: string;
let database: string;
let mint: ReturnType<typeof startMintFixture>;
let service: Awaited<ReturnType<typeof startReceivingServer>> | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "soi-restart-"));
  database = join(directory, "wallet.sqlite");
  mint = startMintFixture();
});
afterEach(async () => {
  await service?.stop(); service = undefined;
  await mint.stop();
  rmSync(directory, { recursive: true, force: true });
});
const config = () => ({ ...SETUP, mintUrl: mint.url, payoutThresholdSats: 1000 });
const inspect = () => inspectStatus(database, config());
async function start() {
  service = await startReceivingServer({ database, config: config(), port: 0, retryDelayMs: 50,
    timing: { pollingIntervalMs: 100, processorIntervalMs: 20 } });
}
function request(path: string) { return fetch(`http://127.0.0.1:${service!.port}${path}`, { headers: { Host: "pay.example" } }); }
async function invoice(sats: number) {
  const response = await request(`/lnurlp/alice/callback?amount=${sats * 1000}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { pr: string }).pr;
}
async function eventually(check: () => Promise<boolean> | boolean, description: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(40);
  }
  throw new Error(`Timed out: ${description}`);
}

test("startup remains ready through a quote-check outage and Coco later claims and sweeps once", async () => {
  await start();
  const payment = await invoice(1000);
  await service!.stop();
  mint.pay(payment);
  mint.state.quoteStatusUnavailable = true;
  await start();
  expect((await request("/readyz")).status).toBe(200);
  expect((await inspect()).live?.readiness).toBe("ready");
  // New invoices remain available while Coco retries the saved payment.
  await invoice(21);
  expect((await inspect()).mints[0]!.spendableSats).toBe("0");
  expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(0);
  expect(mint.state.meltRequests).toBe(0);
  mint.state.quoteStatusUnavailable = false;
  await eventually(() => mint.state.meltRequests === 1, "payout after Coco claims the saved receipt");
  expect(mint.state.issuanceCount).toBe(1);
  expect(mint.submissions[0]!.quote.request).toBe(FIRST_ADDRESS);
  expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(1);
}, 20_000);

test("a paid quote without a prepared operation is claimed by Coco without blocking readiness", async () => {
  await start();
  await service!.stop(); service = undefined;
  const connection = openInstance(database, config());
  const wallet = await initializeCoco({ repo: new SqliteRepositories({ database: connection.sqlite }),
    seedGetter: async () => connection.store.getSeed() });
  let payment: string;
  try {
    payment = (await wallet.quotes.mint.create({ mintUrl: mint.url, method: "bolt11", unit: "sat", amount: 21 })).request;
  } finally { await wallet.dispose(); connection.close(); }
  mint.pay(payment!);
  mint.state.issuancePaused = true;
  await start();
  expect((await request("/readyz")).status).toBe(200);
  expect((await inspect()).live?.readiness).toBe("ready");
  expect((await inspect()).mints[0]!.spendableSats).toBe("0");
  mint.state.issuancePaused = false;
  await eventually(async () => (await inspect()).mints[0]!.spendableSats === "21", "Coco claims the quote without an application operation");
  expect(mint.state.issuanceCount).toBe(1);
  expect((await inspect()).mints[0]!.spendableSats).toBe("21");
}, 20_000);

async function spawnServer(username = SETUP.username) {
  const module = new URL("../src/server.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `
    const { startReceivingServer } = await import(process.argv[1]);
    const server = await startReceivingServer({ database: process.argv[2], port: 0, retryDelayMs: 50,
      timing: { pollingIntervalMs: 100, processorIntervalMs: 20 } });
    console.log(server.port);
    process.on('SIGTERM', async () => { await server.stop(); });
  `, module, database], { stdout: "pipe", stderr: "pipe", env: { ...process.env,
    SOI_USERNAME: username, SOI_XPUB: SETUP.destinationKey, SOI_MINT_URL: mint.url, SOI_PAYOUT_THRESHOLD_SATS: "1000" } });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  const port = Number(new TextDecoder().decode(first.value).trim());
  expect(port).toBeGreaterThan(0);
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { Host: "pay.example" } });
  await eventually(async () => (await get("/readyz")).status === 200, "initial readiness");
  return { child, reader, get };
}

test("full shutdown and new processes recover receipts and payouts settled while stopped", async () => {
  mint.state.pendingPayouts = true;
  let process = await spawnServer();
  try {
    const firstStart = (await inspect()).live!.startedAt;
    const payment = ((await (await process.get("/lnurlp/alice/callback?amount=1000000")).json()) as { pr: string }).pr;
    process.child.kill("SIGTERM");
    expect(await process.child.exited).toBe(0);
    process.reader.releaseLock();
    mint.pay(payment);
    expect((await inspect()).live).toBeNull();
    expect(mint.state.issuanceCount).toBe(0);
    expect(mint.state.meltRequests).toBe(0);

    process = await spawnServer();
    expect((await inspect()).live!.startedAt).not.toBe(firstStart);
    await eventually(async () => (await inspect()).mints[0]!.payouts[0]?.state === "pending", "payout after offline receipt");
    expect(mint.state.issuanceCount).toBe(1);
    expect(mint.state.meltAttempts).toBe(1);
    expect(mint.submissions[0]!.quote.request).toBe(FIRST_ADDRESS);
    const secondStart = (await inspect()).live!.startedAt;
    process.child.kill("SIGTERM");
    expect(await process.child.exited).toBe(0);
    process.reader.releaseLock();
    mint.settle(mint.submissions[0]!.quote.quote);
    expect((await inspect()).mints[0]!.payouts[0]!.state).toBe("pending");

    process = await spawnServer();
    expect((await inspect()).live!.startedAt).not.toBe(secondStart);
    await eventually(async () => (await inspect()).mints[0]!.payouts[0]?.state === "finalized", "Coco settles the payout after restart");
    const recovered = await inspect();
    expect(recovered.mints[0]!.payouts[0]!.state).toBe("finalized");
    expect(recovered.mints[0]!.spendableSats).toBe("3");
    expect(recovered.lastActiveIdentity.nextPayoutIndex).toBe(1);
    expect(mint.state.meltAttempts).toBe(1);
    expect(mint.state.issuanceCount).toBe(1);

    mint.state.pendingPayouts = false;
    const next = ((await (await process.get("/lnurlp/alice/callback?amount=1000000")).json()) as { pr: string }).pr;
    mint.pay(next);
    await eventually(() => mint.state.meltRequests === 2, "next payout after restart");
    expect(mint.submissions[1]!.quote.request).toBe(SECOND_ADDRESS);
    expect(mint.state.meltAttempts).toBe(2);
    expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(2);
  } finally {
    process.child.kill("SIGTERM");
    await process.child.exited;
    process.reader.releaseLock();
  }
}, 30_000);

test("crash after mint accepts payout preserves submission, destination and shared index", async () => {
  mint.state.pendingPayouts = true;
  mint.state.holdMeltResponses = true;
  let process = await spawnServer();
  try {
    const payment = ((await (await process.get("/lnurlp/alice/callback?amount=1000000")).json()) as { pr: string }).pr;
    mint.pay(payment);
    await eventually(() => mint.state.meltRequests === 1, "mint accepts withdrawal");
    expect((await inspect()).mints[0]!.payouts[0]!.state).toBe("executing");
    expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(1);
    process.child.kill("SIGKILL");
    await process.child.exited;
    process.reader.releaseLock();
    mint.settle(mint.submissions[0]!.quote.quote);
    mint.state.holdMeltResponses = false;
    mint.state.pendingPayouts = false;
    process = await spawnServer("bob");
    await eventually(async () => (await inspect()).mints[0]!.payouts[0]?.state === "finalized", "Coco reconciles accepted payout");
    await eventually(async () => (await process.get("/readyz")).status === 200, "ready after settlement");
    const recovered = await inspect();
    expect(recovered.mints[0]!.spendableSats).toBe("3");
    expect(recovered.mints[0]!.payouts[0]!.destination).toBe(FIRST_ADDRESS);
    expect(recovered.lastActiveIdentity.nextPayoutIndex).toBe(1);
    expect(mint.state.meltRequests).toBe(1);
    expect(mint.state.issuanceCount).toBe(1);
    expect(mint.state.meltAttempts).toBe(1);
    const next = ((await (await process.get("/lnurlp/bob/callback?amount=1000000")).json()) as { pr: string }).pr;
    mint.pay(next);
    await eventually(() => mint.state.meltRequests === 2, "new payout uses next shared index");
    expect(mint.submissions[1]!.quote.request).toBe(SECOND_ADDRESS);
    expect(mint.state.meltAttempts).toBe(2);
    expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(2);
  } finally {
    mint.state.holdMeltResponses = false;
    process.child.kill("SIGTERM");
    await process.child.exited;
    process.reader.releaseLock();
  }
}, 30_000);

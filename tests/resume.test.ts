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
  directory = mkdtempSync(join(tmpdir(), "soi-resume-"));
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

test("cold start stays unready when persisted payment reconciliation fails, then claims and sweeps once", async () => {
  await start();
  const payment = await invoice(1000);
  await service!.stop();
  mint.pay(payment);
  mint.state.quoteStatusUnavailable = true;
  await start();
  expect((await request("/readyz")).status).toBe(503);
  expect((await inspect()).live?.readiness).toBe("reconciling");
  expect((await inspect()).live?.lastReconciledAt).toBeNull();
  expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(0);
  expect(mint.state.meltRequests).toBe(0);
  mint.state.quoteStatusUnavailable = false;
  await eventually(() => service!.status === "ready", "reconciliation becomes ready");
  await eventually(() => mint.state.meltRequests === 1, "payout after reconciliation");
  expect(mint.state.issuanceCount).toBe(1);
  expect(mint.submissions[0]!.quote.request).toBe(FIRST_ADDRESS);
  expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(1);
}, 20_000);

test("a paid quote persisted before operation preparation stays unready until Coco claims it", async () => {
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
  expect((await request("/readyz")).status).toBe(503);
  expect((await inspect()).live?.lastReconciledAt).toBeNull();
  mint.state.issuancePaused = false;
  await eventually(() => service!.status === "ready", "Coco claims the quote without an application operation");
  expect(mint.state.issuanceCount).toBe(1);
  expect((await inspect()).mints[0]!.spendableSats).toBe("21");
}, 20_000);

async function spawnServer(username = SETUP.username) {
  const module = new URL("../src/server.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `
    const { startReceivingServer } = await import(process.argv[1]);
    const server = await startReceivingServer({ database: process.argv[2], port: 0, retryDelayMs: 50,
      timing: { pollingIntervalMs: 100, processorIntervalMs: 20, suspensionThresholdMs: 500 } });
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

for (const transport of ["closed", "silent"] as const) test(`warm resume reconciles missed payments with a ${transport} mint WebSocket`, async () => {
  await mint.stop();
  mint = startMintFixture({ websocket: true });
  const { child, reader, get } = await spawnServer();
  try {
    const response = await get("/lnurlp/alice/callback?amount=1000000");
    expect(response.status).toBe(200);
    const payment = ((await response.json()) as { pr: string }).pr;
    await eventually(() => mint.state.wsConnections > 0, "mint WebSocket connection");
    const beforePause = (await inspect()).live!;
    const startedAt = beforePause.startedAt;
    child.kill("SIGSTOP");
    await Bun.sleep(750);
    if (transport === "closed") mint.closeSockets();
    mint.state.dropNotifications = true;
    mint.pay(payment);
    mint.state.quoteStatusUnavailable = true;
    expect(mint.state.issuanceCount).toBe(0);
    child.kill("SIGCONT");
    expect((await get("/readyz")).status).toBe(503);
    expect((await inspect()).live?.readiness).toBe("reconciling");
    expect(mint.state.meltRequests).toBe(0);
    mint.state.quoteStatusUnavailable = false;
    await eventually(async () => (await get("/readyz")).status === 200, "warm reconciliation");
    await eventually(() => mint.state.meltRequests === 1, "warm payout");
    expect((await inspect()).live?.startedAt).toBe(startedAt);
    expect((await inspect()).live?.lastReconciledAt! > beforePause.lastReconciledAt!).toBe(true);
    expect(mint.state.issuanceCount).toBe(1);
    expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(1);
    // The default watchers/processors must still handle new work after resume.
    const next = ((await (await get("/lnurlp/alice/callback?amount=21000")).json()) as { pr: string }).pr;
    mint.pay(next);
    await eventually(() => mint.state.issuanceCount === 2, "continued polling without WebSocket events");
    expect(mint.state.meltRequests).toBe(1);
  } finally {
    child.kill("SIGCONT"); child.kill("SIGTERM");
    await child.exited;
    reader.releaseLock();
  }
}, 20_000);

for (const interruption of ["suspend", "crash"] as const) test(`${interruption} after mint accepts payout preserves submission, destination and shared index`, async () => {
  mint.state.pendingPayouts = true;
  mint.state.holdMeltResponses = true;
  let process = await spawnServer();
  try {
    const payment = ((await (await process.get("/lnurlp/alice/callback?amount=1000000")).json()) as { pr: string }).pr;
    mint.pay(payment);
    await eventually(() => mint.state.meltRequests === 1, "mint accepts withdrawal");
    expect((await inspect()).mints[0]!.payouts[0]!.state).toBe("executing");
    expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(1);
    if (interruption === "suspend") {
      process.child.kill("SIGSTOP");
      await Bun.sleep(750);
    } else {
      process.child.kill("SIGKILL");
      await process.child.exited;
      process.reader.releaseLock();
    }
    mint.settle(mint.submissions[0]!.quote.quote);
    mint.state.holdMeltResponses = false;
    mint.state.pendingPayouts = false;
    if (interruption === "suspend") process.child.kill("SIGCONT");
    else process = await spawnServer("bob");
    await eventually(async () => (await inspect()).mints[0]!.payouts[0]?.state === "finalized", "Coco reconciles accepted payout");
    await eventually(async () => (await process.get("/readyz")).status === 200, "ready after settlement");
    const recovered = await inspect();
    expect(recovered.mints[0]!.spendableSats).toBe("3");
    expect(recovered.mints[0]!.payouts[0]!.destination).toBe(FIRST_ADDRESS);
    expect(recovered.lastActiveIdentity.nextPayoutIndex).toBe(1);
    expect(mint.state.meltRequests).toBe(1);
    expect(mint.state.issuanceCount).toBe(1);
    expect(mint.state.meltAttempts).toBe(1);
    const username = interruption === "crash" ? "bob" : "alice";
    const next = ((await (await process.get(`/lnurlp/${username}/callback?amount=1000000`)).json()) as { pr: string }).pr;
    mint.pay(next);
    await eventually(() => mint.state.meltRequests === 2, "new payout uses next shared index");
    expect(mint.submissions[1]!.quote.request).toBe(SECOND_ADDRESS);
    expect(mint.state.meltAttempts).toBe(2);
    expect((await inspect()).lastActiveIdentity.nextPayoutIndex).toBe(2);
  } finally {
    mint.state.holdMeltResponses = false;
    process.child.kill("SIGCONT"); process.child.kill("SIGTERM");
    await process.child.exited;
    process.reader.releaseLock();
  }
}, 30_000);

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HDKey } from "@scure/bip32";
import { derivePayoutAddress } from "../src/destination.ts";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { startReceivingServer } from "../src/server.ts";
import { verifyInstance } from "../src/setup.ts";
import { inspectStatus } from "../src/status.ts";
import { openDatabase } from "../src/storage/database.ts";
import { FIRST_ADDRESS, SECOND_ADDRESS, SETUP } from "./fixtures.ts";
import { startMintFixture } from "./mint-fixture.ts";

let directory: string;
let database: string;
let mint: ReturnType<typeof startMintFixture>;
let service: Awaited<ReturnType<typeof startReceivingServer>> | undefined;
let messages: string[];
let thresholdSats = 1000;
function config() { return { ...SETUP, mintUrl: mint.url, payoutThresholdSats: thresholdSats }; }
async function verify() { return verifyInstance(database, config()); }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "soi-payout-"));
  database = join(directory, "wallet.sqlite");
  mint = startMintFixture();
  messages = [];
  thresholdSats = 1000;
});
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await mint?.stop();
  rmSync(directory, { recursive: true, force: true });
});
async function start(threshold = thresholdSats) {
  thresholdSats = threshold;
  service = await startReceivingServer({ database, config: config(), port: 0, onPayout: (message) => messages.push(message),
    timing: { pollingIntervalMs: 500, processorIntervalMs: 20 } });
}
async function receive(amount: number) {
  const response = await fetch(`http://127.0.0.1:${service!.port}/lnurlp/alice/callback?amount=${amount * 1000}`,
    { headers: { Host: "pay.example" } });
  expect(response.status).toBe(200);
  mint.pay((await response.json() as { pr: string }).pr);
}
async function eventually(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(40);
  }
  throw new Error(`Timed out. Payout messages: ${messages.join("\n")}`);
}
async function operations() {
  const connection = openDatabase(database, false);
  try {
    const repo = new SqliteRepositories({ database: connection.sqlite });
    await repo.init();
    return await Promise.all(mint.submissions.map(async ({ quote }) =>
      (await repo.meltOperationRepository.getByQuoteId(mint.url, quote.quote))[0]));
  } finally { connection.close(); }
}

test("below threshold is inactive; equality sweeps to index zero using the lowest fee identifier and retains change", async () => {
  await start();
  await receive(999);
  await eventually(async () => (await verify()).accumulatedBalanceSats === "999");
  expect(mint.melts.size).toBe(0);
  expect((await verify()).config.nextPayoutIndex).toBe(0);
  await receive(1);
  await eventually(async () => (await operations())[0]?.state === "finalized");
  const { quote } = mint.submissions[0]!;
  expect(quote.request).toBe(FIRST_ADDRESS);
  expect(quote.amount).toBe(990);
  expect(quote.selected_fee_index).toBe(7);
  expect(mint.state.meltRequests).toBe(1);
  expect((await verify()).config.nextPayoutIndex).toBe(1);
  expect((await verify()).accumulatedBalanceSats).toBe("3");
  const [operation] = await operations();
  expect(operation?.state).toBe("finalized");
  if (operation?.state === "finalized") {
    expect(operation.changeAmount?.toString()).toBe("3");
    expect(operation.effectiveFee?.toString()).toBe("7");
    expect(operation.finalizedData?.outpoint).toBe(`${"ab".repeat(32)}:0`);
  }
  await service!.stop(); service = undefined;
  expect((await verify()).accumulatedBalanceSats).toBe("3");
}, 40000);

test("above threshold sweeps the balance including positive input fees, not a threshold-sized amount", async () => {
  mint.keyset.input_fee_ppk = 1000;
  await start();
  await receive(2048);
  await eventually(async () => (await operations())[0]?.state === "finalized");
  const submission = mint.submissions[0]!;
  const fee = submission.inputs.length;
  expect(submission.quote.amount).toBe(2048 - fee - 10);
  expect(submission.quote.amount).toBeGreaterThan(1000);
  expect((await verify()).accumulatedBalanceSats).toBe("3");
}, 40000);

test("new receipts can pay a second address while the first payout is pending; reservations cannot be spent twice", async () => {
  mint.state.pendingPayouts = true;
  await start();
  await receive(1000);
  await eventually(async () => (await operations())[0]?.state === "pending");
  expect((await verify()).accumulatedBalanceSats).toBe("0");
  const pendingStatus = await inspectStatus(database, config());
  expect(pendingStatus.mints.find((m) => m.selected)).toMatchObject({ spendableSats: "0", reservedForPayoutsSats: "1000" });
  expect(pendingStatus.mints.find((m) => m.selected)?.payouts[0]).toMatchObject({ state: "pending", destination: FIRST_ADDRESS, bitcoinState: "unavailable" });
  expect(pendingStatus.live?.config.username).toBe("alice");
  await Promise.all([receive(600), receive(400)]);
  await eventually(async () => (await operations()).filter((op) => op?.state === "pending").length === 2);
  expect(mint.submissions.map(({ quote }) => quote.request)).toEqual([FIRST_ADDRESS, SECOND_ADDRESS]);
  const firstSecrets = new Set(mint.submissions[0]!.inputs.map((p) => p.secret));
  expect(mint.submissions[1]!.inputs.some((p) => firstSecrets.has(p.secret))).toBe(false);
  expect((await verify()).config.nextPayoutIndex).toBe(2);
  mint.submissions.forEach(({ quote }) => mint.settle(quote.quote));
  await eventually(async () => (await operations()).every((op) => op?.state === "finalized"));
  expect((await verify()).accumulatedBalanceSats).toBe("6");
  const settled = await inspectStatus(database, config());
  expect(settled.mints.find((m) => m.selected)?.reservedForPayoutsSats).toBe("0");
  expect(settled.mints.find((m) => m.selected)?.payouts.every((p) => p.bitcoinState === "broadcast; confirmation unavailable")).toBe(true);
}, 40000);

test("underfunded pre-swaps are cancelled and requoted before any submission", async () => {
  mint.keyset.input_fee_ppk = 25_000;
  await start();
  await receive(1000);
  await eventually(async () => (await operations())[0]?.state === "finalized");
  expect(messages.filter((message) => message.includes("rolled_back")).length).toBeGreaterThan(0);
  expect(mint.state.meltRequests).toBe(1);
  const submission = mint.submissions[0]!;
  expect(submission.quote.amount + 10 + submission.inputs.length * 25).toBeLessThanOrEqual(
    submission.inputs.reduce((sum, p) => sum + p.amount, 0));
  expect((await verify()).config.nextPayoutIndex).toBe(1);
}, 40000);

for (const scenario of ["unaffordable", "out-of-range", "quote failure"] as const) {
  test(`${scenario} is surfaced and consumes one index without submitting a payout`, async () => {
    if (scenario === "unaffordable") mint.state.feeReserve = 2000;
    if (scenario === "out-of-range") mint.info.nuts["5"].methods[0]!.max_amount = 500;
    if (scenario === "quote failure") mint.state.payoutUnavailable = true;
    await start();
    await receive(1000);
    await eventually(() => messages.some((message) => /cannot cover|maximum payout|could not complete/.test(message)));
    expect(mint.state.meltRequests).toBe(0);
    expect((await verify()).accumulatedBalanceSats).toBe("1000");
    expect((await verify()).config.nextPayoutIndex).toBe(1);
    expect((await inspectStatus(database, config())).live?.lastPayout?.message).toMatch(/cannot cover|maximum payout|could not complete/);
  }, 40000);
}

test("restart reconciles a submitted payout without replay or index rollback", async () => {
  mint.state.pendingPayouts = true;
  await start();
  await receive(1000);
  await eventually(async () => (await operations())[0]?.state === "pending");
  await service!.stop(); service = undefined;
  mint.settle(mint.submissions[0]!.quote.quote);
  await start();
  await eventually(async () => (await operations())[0]?.state === "finalized");
  expect(mint.state.meltRequests).toBe(1);
  expect((await verify()).config.nextPayoutIndex).toBe(1);
  expect((await verify()).accumulatedBalanceSats).toBe("3");
}, 40000);

test("startup sweeps persisted spendable funds and keeps the allocated index after reopening", async () => {
  await start(2000);
  await receive(1000);
  await eventually(async () => (await verify()).accumulatedBalanceSats === "1000");
  await service!.stop(); service = undefined;
  await start(1000);
  await eventually(async () => (await operations())[0]?.state === "finalized");
  expect(mint.submissions[0]!.quote.request).toBe(FIRST_ADDRESS);
  expect((await verify()).config.nextPayoutIndex).toBe(1);
}, 40000);

test("Coco executes an affordable pre-swap and accounts for both sets of input fees", async () => {
  mint.keyset.input_fee_ppk = 15_000;
  await start(500);
  await receive(500);
  await eventually(async () => (await operations())[0]?.state === "finalized");
  expect(mint.state.swapRequests).toBe(1);
  const operation = (await operations())[0]!;
  expect("needsSwap" in operation && operation.needsSwap).toBe(true);
  const submission = mint.submissions[0]!;
  expect(submission.quote.amount + 10 + submission.inputs.length * 15).toBeLessThanOrEqual(
    submission.inputs.reduce((sum, p) => sum + p.amount, 0));
  expect((await verify()).config.nextPayoutIndex).toBe(1);
}, 40000);

test("an exhausted payout index refuses new payouts without changing wallet funds", async () => {
  await start();
  const connection = openDatabase(database, false);
  connection.sqlite.query("UPDATE soi_destination SET next_payout_index = 2147483648").run();
  connection.close();
  await receive(1000);
  await eventually(() => messages.some((message) => message.includes("Payout index must be an unhardened integer")));
  expect(mint.melts.size).toBe(0);
  expect((await verify()).accumulatedBalanceSats).toBe("1000");
  expect((await verify()).config.nextPayoutIndex).toBe(2147483648);
}, 40000);


test("switching mint and identity preserves old funds and recovers submitted payouts without sweeping the old mint", async () => {
  mint.state.pendingPayouts = true;
  await start();
  await receive(1000);
  await eventually(async () => (await operations())[0]?.state === "pending");
  await receive(400);
  await eventually(async () => (await verify()).accumulatedBalanceSats === "400");
  const original = (await verify()).config;
  const other = startMintFixture();
  const key = HDKey.fromMasterSeed(new Uint8Array(32).fill(3)).derive("m/84'/0'/0'").publicExtendedKey;
  const changed = { ...config(), username: "bob", destinationKey: key, mintUrl: other.url, payoutThresholdSats: 100 };
  const beforeRestart = await inspectStatus(database, changed);
  expect(beforeRestart.lastActiveIdentity.identityId).toBe(original.identityId);
  expect(beforeRestart.nextStart).toMatchObject({ username: "bob", identityId: null, nextPayoutIndex: 0 });
  expect(beforeRestart.live?.config).toMatchObject({ username: "alice", mintUrl: mint.url, payoutThresholdSats: 1000 });
  expect(beforeRestart.mints.find((m) => m.mintUrl === mint.url)).toMatchObject({ spendableSats: "400", reservedForPayoutsSats: "1000" });
  await service!.stop(); service = undefined;
  mint.settle(mint.submissions[0]!.quote.quote);
  try {
    service = await startReceivingServer({ database, config: changed, port: 0,
      timing: { pollingIntervalMs: 500, processorIntervalMs: 20 }, onPayout: (message) => messages.push(message) });
    expect(service.status).toBe("ready");
    await eventually(async () => (await operations())[0]?.state === "finalized");
    expect(mint.state.meltRequests).toBe(1);
    expect(mint.submissions[0]!.quote.request).toBe(FIRST_ADDRESS);
    expect((await verifyInstance(database, config())).accumulatedBalanceSats).toBe("403");
    const current = await verifyInstance(database, changed);
    expect(current.accumulatedBalanceSats).toBe("0");
    expect(current.config.destinationId).not.toBe(original.destinationId);
    expect(current.config.nextPayoutIndex).toBe(0);
    const afterRestart = await inspectStatus(database, changed);
    expect(afterRestart.live?.config).toMatchObject({ username: "bob", mintUrl: other.url, payoutThresholdSats: 100 });
    expect(afterRestart.lastActiveIdentity.identityId).toBe(current.config.identityId);
    expect(afterRestart.mints.find((m) => m.mintUrl === mint.url)).toMatchObject({ spendableSats: "403", reservedForPayoutsSats: "0" });
    expect(afterRestart.mints.find((m) => m.mintUrl === mint.url)?.payouts[0]?.destination).toBe(FIRST_ADDRESS);
    expect(other.state.meltRequests).toBe(0);
    const base = `http://127.0.0.1:${service.port}`;
    expect((await fetch(`${base}/.well-known/lnurlp/alice`)).status).toBe(404);
    expect((await fetch(`${base}/.well-known/lnurlp/bob`)).status).toBe(200);
    const invoice = await fetch(`${base}/lnurlp/bob/callback?amount=500000`);
    expect(invoice.status).toBe(200);
    other.pay((await invoice.json() as { pr: string }).pr);
    await eventually(() => other.state.meltRequests === 1);
    await eventually(async () => (await verifyInstance(database, changed)).accumulatedBalanceSats === "3");
    expect(other.submissions[0]!.quote.request).toBe(derivePayoutAddress(key, 0));
    expect(mint.state.meltRequests).toBe(1);
    expect((await verifyInstance(database, config())).accumulatedBalanceSats).toBe("403");
    expect((await verifyInstance(database, config())).config.nextPayoutIndex).toBe(1);
    expect((await verifyInstance(database, changed)).config.nextPayoutIndex).toBe(1);
    await service.stop(); service = undefined;
    await start();
    const resumed = await inspectStatus(database, config());
    expect(resumed.lastActiveIdentity.identityId).toBe(original.identityId);
    expect(resumed.nextStart.nextPayoutIndex).toBe(1);
    expect(resumed.live?.config.destinationId).toBe(original.destinationId);
    expect(mint.state.meltRequests).toBe(1);
  } finally {
    await service?.stop(); service = undefined;
    await other.stop();
  }
}, 40000);

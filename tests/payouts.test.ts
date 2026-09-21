import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { startReceivingServer } from "../src/server.ts";
import { setupInstance, verifyInstance } from "../src/setup.ts";
import { openDatabase } from "../src/storage/database.ts";
import { FIRST_ADDRESS, SECOND_ADDRESS, SETUP } from "./fixtures.ts";
import { startMintFixture } from "./mint-fixture.ts";

let directory: string;
let database: string;
let mint: ReturnType<typeof startMintFixture>;
let service: Awaited<ReturnType<typeof startReceivingServer>> | undefined;
let messages: string[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "soi-payout-"));
  database = join(directory, "wallet.sqlite");
  mint = startMintFixture();
  messages = [];
});
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await mint?.stop();
  rmSync(directory, { recursive: true, force: true });
});
async function start(threshold = 1000) {
  await setupInstance(database, { ...SETUP, mintUrl: mint.url, payoutThresholdSats: threshold });
  service = await startReceivingServer({ database, port: 0, onPayout: (message) => messages.push(message),
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
  await eventually(async () => (await verifyInstance(database)).accumulatedBalanceSats === "999");
  expect(mint.melts.size).toBe(0);
  expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(0);
  await receive(1);
  await eventually(async () => (await operations())[0]?.state === "finalized");
  const { quote } = mint.submissions[0]!;
  expect(quote.request).toBe(FIRST_ADDRESS);
  expect(quote.amount).toBe(990);
  expect(quote.selected_fee_index).toBe(7);
  expect(mint.state.meltRequests).toBe(1);
  expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(1);
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("3");
  const [operation] = await operations();
  expect(operation?.state).toBe("finalized");
  if (operation?.state === "finalized") {
    expect(operation.changeAmount?.toString()).toBe("3");
    expect(operation.effectiveFee?.toString()).toBe("7");
    expect(operation.finalizedData?.outpoint).toBe(`${"ab".repeat(32)}:0`);
  }
  await service!.stop(); service = undefined;
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("3");
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
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("3");
}, 40000);

test("new receipts can pay a second address while the first payout is pending; reservations cannot be spent twice", async () => {
  mint.state.pendingPayouts = true;
  await start();
  await receive(1000);
  await eventually(async () => (await operations())[0]?.state === "pending");
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("0");
  await Promise.all([receive(600), receive(400)]);
  await eventually(async () => (await operations()).filter((op) => op?.state === "pending").length === 2);
  expect(mint.submissions.map(({ quote }) => quote.request)).toEqual([FIRST_ADDRESS, SECOND_ADDRESS]);
  const firstSecrets = new Set(mint.submissions[0]!.inputs.map((p) => p.secret));
  expect(mint.submissions[1]!.inputs.some((p) => firstSecrets.has(p.secret))).toBe(false);
  expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(2);
  mint.submissions.forEach(({ quote }) => mint.settle(quote.quote));
  await eventually(async () => (await operations()).every((op) => op?.state === "finalized"));
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("6");
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
  expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(1);
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
    expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("1000");
    expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(1);
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
  expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(1);
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("3");
}, 40000);

test("startup sweeps persisted spendable funds and keeps the allocated index after reopening", async () => {
  await start(2000);
  await receive(1000);
  await eventually(async () => (await verifyInstance(database)).accumulatedBalanceSats === "1000");
  await service!.stop(); service = undefined;
  const connection = openDatabase(database, false);
  connection.sqlite.query("UPDATE soi_settings SET value = '1000' WHERE key = 'payoutThresholdSats'").run();
  connection.close();
  await start();
  await eventually(async () => (await operations())[0]?.state === "finalized");
  expect(mint.submissions[0]!.quote.request).toBe(FIRST_ADDRESS);
  expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(1);
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
  expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(1);
}, 40000);

test("an exhausted payout index refuses new payouts without changing wallet funds", async () => {
  await start();
  const connection = openDatabase(database, false);
  connection.sqlite.query("UPDATE soi_identity SET next_payout_index = 2147483648").run();
  connection.close();
  await receive(1000);
  await eventually(() => messages.some((message) => message.includes("Payout index must be an unhardened integer")));
  expect(mint.melts.size).toBe(0);
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("1000");
  expect((await verifyInstance(database)).config.nextPayoutIndex).toBe(2147483648);
}, 40000);

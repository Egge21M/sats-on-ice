import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { LightningAddress } from "@getalby/lightning-tools/lnurl";
import { startReceivingServer } from "../src/server.ts";
import { setupInstance, verifyInstance } from "../src/setup.ts";
import { openDatabase } from "../src/storage/database.ts";
import { ConfigStore } from "../src/storage/config-store.ts";
import { SETUP } from "./fixtures.ts";
import { startMintFixture } from "./mint-fixture.ts";

let directory: string;
let database: string;
let mint: ReturnType<typeof startMintFixture>;
let service: Awaited<ReturnType<typeof startReceivingServer>> | undefined;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "soi-receiving-"));
  database = join(directory, "wallet.sqlite");
  mint = startMintFixture();
  await setupInstance(database, { ...SETUP, mintUrl: mint.url });
});
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await mint?.stop();
  rmSync(directory, { recursive: true, force: true });
});

async function start() {
  service = await startReceivingServer({ database, port: 0, retryDelayMs: 40,
    timing: { pollingIntervalMs: 200, processorIntervalMs: 20 } });
  return service;
}
function request(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${service!.port}${path}`, { ...init, headers: { Host: "pay.example", ...init?.headers } });
}
async function eventually(check: () => Promise<boolean> | boolean, description: string, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(40);
  }
  throw new Error(`Timed out: ${description}`);
}
async function inspect() {
  const connection = openDatabase(database, false);
  try {
    const repo = new SqliteRepositories({ database: connection.sqlite });
    await repo.init();
    return {
      seedDigest: new Bun.CryptoHasher("sha256").update(new ConfigStore(connection.db).getSeed()).digest("hex"),
      proofs: await repo.proofRepository.getReadyProofs(mint.url),
      quotes: await repo.mintQuoteRepository.getPendingMintQuotes(),
      operations: await repo.mintOperationRepository.getPending(),
    };
  } finally { connection.close(); }
}

test("discovery uses the public Host and exposes only the configured LNURL endpoints", async () => {
  await start();
  expect(service!.status).toBe("ready");
  const response = await request("/.well-known/lnurlp/alice", { headers: { "X-Forwarded-Host": "wrong.example" } });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    tag: "payRequest", callback: "https://pay.example/lnurlp/alice/callback",
    minSendable: 1000, maxSendable: 10_000_000,
    metadata: '[["text/plain","Payment to alice@pay.example"]]',
  });
  for (const path of ["/", "/health", "/balance", "/status", "/.well-known/lnurlp/bob", "/lnurlp/bob/callback"]) {
    expect((await request(path)).status).toBe(404);
  }
  expect((await request("/.well-known/lnurlp/alice", { method: "POST" })).status).toBe(405);
  expect((await request("/.well-known/lnurlp/alice", { headers: { Host: "user@evil.example" } })).status).toBe(400);
  expect(mint.state.quoteRequests).toBe(0);
});

test("rejects invalid, fractional, duplicated and out-of-range amounts before creating a quote", async () => {
  await start();
  for (const query of ["", "amount=", "amount=0", "amount=-1000", "amount=1001", "amount=1.5", "amount=1e6",
    "amount=10000001", "amount=9007199254740992", "amount=1000&amount=2000", "amount=%201000", "amount=Infinity"]) {
    const response = await request(`/lnurlp/alice/callback?${query}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { status: string }).status).toBe("ERROR");
  }
  expect(mint.state.quoteRequests).toBe(0);
});

test("persists issuance before returning a fresh invoice for each callback; unpaid funds are not spendable", async () => {
  await start();
  const first = await request("/lnurlp/alice/callback?amount=1000");
  expect(first.status).toBe(200);
  const firstInvoice = ((await first.json()) as { pr: string }).pr;
  const second = await request("/lnurlp/alice/callback?amount=1000");
  expect(second.status).toBe(200);
  expect(((await second.json()) as { pr: string }).pr).not.toBe(firstInvoice);
  const stored = await inspect();
  expect(stored.quotes).toHaveLength(2);
  expect(stored.operations).toHaveLength(2);
  expect(stored.operations.every((op) => op.state === "pending" && op.outputData)).toBe(true);
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("0");
});

test("a paid invoice becomes valid spendable ecash once and survives reopening with the same seed", async () => {
  await start();
  const before = await inspect();
  const response = await request("/lnurlp/alice/callback?amount=21000");
  expect(response.status).toBe(200);
  const invoice = ((await response.json()) as { pr: string }).pr;
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("0");
  mint.pay(invoice);
  await eventually(async () => (await verifyInstance(database)).accumulatedBalanceSats === "21", "claim 21 sats");
  mint.pay(invoice);
  const stored = await inspect();
  expect(stored.proofs.length).toBeGreaterThan(0);
  expect(stored.proofs.every((proof) => mint.verifies(proof))).toBe(true);
  await service!.stop();
  await start();
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("21");
  expect((await inspect()).seedDigest).toBe(before.seedDigest);
  expect(mint.state.issuanceCount).toBe(1);
}, 20_000);

test("claims an invoice paid while stopped exactly once after cold start", async () => {
  await start();
  const invoice = ((await (await request("/lnurlp/alice/callback?amount=32000")).json()) as { pr: string }).pr;
  await service!.stop();
  mint.pay(invoice);
  // Local inspection must not start recovery or claim the paid invoice.
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("0");
  expect(mint.state.issuanceCount).toBe(0);
  await start();
  await eventually(async () => (await verifyInstance(database)).accumulatedBalanceSats === "32", "cold-start claim");
  await service!.stop();
  await start();
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("32");
  expect(mint.state.issuanceCount).toBe(1);
}, 20_000);

test("automatically retries temporary mint failure while refusing payment requests", async () => {
  mint.state.unavailable = true;
  await start();
  expect(service!.status).toBe("retrying");
  expect((await request("/.well-known/lnurlp/alice")).status).toBe(503);
  expect((await request("/lnurlp/alice/callback?amount=1000")).status).toBe(503);
  mint.state.unavailable = false;
  await eventually(() => service!.status === "ready", "retry validation");
  expect((await request("/.well-known/lnurlp/alice")).status).toBe(200);
  expect(mint.state.infoRequests).toBeGreaterThan(1);
});

test("rejects a different configured mint before recovering paid invoices", async () => {
  await start();
  const invoice = ((await (await request("/lnurlp/alice/callback?amount=32000")).json()) as { pr: string }).pr;
  await service!.stop(); service = undefined;
  mint.pay(invoice);
  const otherMint = startMintFixture();
  const connection = openDatabase(database, false);
  try {
    connection.sqlite.query("UPDATE soi_settings SET value = ? WHERE key = 'mintUrl'").run(JSON.stringify(otherMint.url));
    await expect(start()).rejects.toThrow("different mint");
    expect(mint.state.issuanceAttempts).toBe(0);
    expect((await inspect()).operations).toHaveLength(1);
  } finally {
    connection.close();
    await otherMint.stop();
  }
});

test("rejects incompatible capabilities on a fresh startup even with cached mint information", async () => {
  await start();
  await service!.stop();
  mint.info.nuts["5"].disabled = true;
  await expect(start()).rejects.toThrow("NUT-05");
});

test("withholds an invoice whose encoded amount differs from the requested amount", async () => {
  await start();
  mint.state.invoiceAmountOffset = 1;
  const response = await request("/lnurlp/alice/callback?amount=21000");
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ status: "ERROR", reason: "Unable to prepare a receiving invoice. Please try again later." });
  expect((await inspect()).operations).toHaveLength(0);
});

test("accepts the advertised maximum exactly", async () => {
  await start();
  const response = await request("/lnurlp/alice/callback?amount=10000000");
  expect(response.status).toBe(200);
  expect([...mint.quotes.values()][0]?.amount).toBe(10_000);
});

test("honors the default invoice expiry and refuses already-expired invoices", async () => {
  await start();
  mint.state.omitInvoiceExpiry = true;
  expect((await request("/lnurlp/alice/callback?amount=1000")).status).toBe(200);
  mint.state.invoiceAgeSeconds = 3601;
  expect((await request("/lnurlp/alice/callback?amount=1000")).status).toBe(502);
  expect((await inspect()).operations).toHaveLength(1);
});

test("payment at the mint alone does not increase the local spendable balance", async () => {
  await start();
  mint.state.issuancePaused = true;
  const invoice = ((await (await request("/lnurlp/alice/callback?amount=21000")).json()) as { pr: string }).pr;
  mint.pay(invoice);
  await eventually(() => mint.state.issuanceAttempts > 0, "observe paid quote");
  expect([...mint.quotes.values()][0]?.state).toBe("PAID");
  expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("0");
  await service!.stop();
  mint.state.issuancePaused = false;
  await start();
  await eventually(async () => (await verifyInstance(database)).accumulatedBalanceSats === "21", "claim after restart");
  expect(mint.state.issuanceCount).toBe(1);
}, 20_000);

test("does not expose an invoice when durable issuance preparation fails", async () => {
  await start();
  const connection = openDatabase(database, false);
  try {
    connection.sqlite.exec(`CREATE TRIGGER fail_pending BEFORE UPDATE ON coco_cashu_mint_operations
      WHEN NEW.state = 'pending' BEGIN SELECT RAISE(FAIL, 'fixture-private-error'); END`);
    const response = await request("/lnurlp/alice/callback?amount=1000");
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body.includes('"pr"')).toBe(false);
    expect(body.includes("fixture-private-error")).toBe(false);
    expect((await inspect()).operations).toHaveLength(0);
  } finally { connection.close(); }
});

test("stopping during connectivity retries cancels further validation", async () => {
  mint.state.unavailable = true;
  await start();
  await service!.stop();
  const attempts = mint.state.infoRequests;
  await Bun.sleep(120);
  expect(mint.state.infoRequests).toBe(attempts);
  expect(service!.status).toBe("stopped");
});

test("serve CLI receives a payment and shuts down on SIGTERM before the database is reopened", async () => {
  const entry = new URL("../index.ts", import.meta.url).pathname;
  const child = Bun.spawn([Bun.which("bun")!, entry, "--database", database, "serve", "--port", "0"], {
    cwd: directory, stdout: "pipe", stderr: "pipe",
  });
  const [logStream, watchStream] = child.stdout.tee();
  const output = new Response(logStream).text();
  const errors = new Response(child.stderr).text();
  const reader = watchStream.getReader();
  try {
    let received = "";
    while (!received.includes("Listening on")) {
      const part = await reader.read();
      if (part.done) throw new Error("Receiving CLI exited before listening.");
      received += new TextDecoder().decode(part.value);
    }
    void reader.cancel();
    const port = received.match(/Listening on 127\.0\.0\.1:(\d+)/)?.[1];
    expect(port).toBeDefined();
    const response = await fetch(`http://127.0.0.1:${port}/lnurlp/alice/callback?amount=21000`, { headers: { Host: "pay.example" } });
    expect(response.status).toBe(200);
    mint.pay(((await response.json()) as { pr: string }).pr);
    // Production Coco transport uses a 20-second backup polling interval.
    await eventually(async () => (await verifyInstance(database)).accumulatedBalanceSats === "21", "CLI claims payment", 30_000);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await errors).toBe("");
    expect(await output).toContain("Receiving stopped.");
    await start();
    expect((await verifyInstance(database)).accumulatedBalanceSats).toBe("21");
    expect(mint.state.issuanceCount).toBe(1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
  }
}, 40_000);

test("Alby Lightning Tools 9.0.1 resolves discovery metadata and accepts the mint's ordinary BOLT11 invoice", async () => {
  await start();
  const originalFetch = globalThis.fetch;
  // Emulate only the HTTPS reverse proxy. The actual payer parses unmodified
  // discovery and invoice responses; mint HTTP and SQLite remain real.
  const proxy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://pay.example") return request(`${url.pathname}${url.search}`, init);
    return originalFetch(input, init);
  }, { preconnect: originalFetch.preconnect }));
  try {
    const payer = new LightningAddress("alice@pay.example", { proxy: false });
    await payer.fetch();
    const invoice = await payer.requestInvoice({ satoshi: 21 });
    expect(invoice.satoshi).toBe(21);
    expect(invoice.description).toBe("Cashu mint quote");
    expect(payer.lnurlpData?.description).toBe("Payment to alice@pay.example");
    mint.pay(invoice.paymentRequest);
    await eventually(async () => (await verifyInstance(database)).accumulatedBalanceSats === "21", "payer fixture settlement");
    expect(mint.state.issuanceCount).toBe(1);
  } finally { proxy.mockRestore(); }
}, 20_000);

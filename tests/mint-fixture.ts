import { hashToCurve, createBlindSignature, createNewMintKeys, pointFromHex, serializeMintKeys, verifyUnblindedSignature } from "@cashu/cashu-ts";
import { encode, sign, decode } from "bolt11";
import type { CoreProof } from "@cashu/coco-core";

// SOI controlled mint fixture v1. No Lightning node, funds or external network.
// Cashu keys and BOLT11 signing keys are deliberately public test material.
const keys = createNewMintKeys(16, new Uint8Array(32).fill(7), { versionByte: 0 });
const publicKeys = serializeMintKeys(keys.pubKeys);
const invoiceKey = "11".repeat(32);
type Quote = { quote: string; request: string; amount: number; unit: "sat"; state: "UNPAID" | "PAID" | "ISSUED"; expiry: number };
type Output = { amount: number; id: string; B_: string };
type Signature = { amount: number; id: string; C_: string };

type Input = { amount: number; id: string; C: string; secret: string };
type MeltQuote = { quote: string; request: string; amount: number; unit: string; expiry: number;
  state: "UNPAID" | "PENDING" | "PAID"; fee_options: { fee_index: number; fee_reserve: number; estimated_blocks: number }[];
  selected_fee_index: number | null; outpoint: string | null; change?: Signature[] };

export function startMintFixture(options: { websocket?: boolean } = {}) {
  type Subscription = { kind: string; filters: string[] };
  type SocketData = { subscriptions: Map<string, Subscription> };
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  const melts = new Map<string, MeltQuote>();
  const spent = new Set<string>();
  const pending = new Set<string>();
  const submissions: { quote: MeltQuote; inputs: Input[]; outputs: Output[] }[] = [];
  const quotes = new Map<string, Quote>();
  const signatures = new Map<string, Signature>();
  const info = {
    name: "SOI controlled mint fixture v1",
    version: "soi-fixture/1",
    nuts: {
      "4": { disabled: false, methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 10_000 }] },
      "5": { disabled: false, methods: [{ method: "onchain", unit: "sat", min_amount: 100, max_amount: 100_000 }] },
      "7": { supported: true },
      "8": { supported: true },
      "9": { supported: true },
      ...options.websocket ? { "17": { supported: [{ method: "bolt11", unit: "sat", commands: ["bolt11_mint_quote"] }] } } : {},
    },
  };
  const state = { unavailable: false, quoteStatusUnavailable: false, issuancePaused: false, invoiceAmountOffset: 0, invoiceAgeSeconds: 0,
    omitInvoiceExpiry: false, issuanceCount: 0, issuanceAttempts: 0, quoteRequests: 0, infoRequests: 0, meltRequests: 0, meltAttempts: 0, swapRequests: 0,
    pendingPayouts: false, holdMeltResponses: false, payoutUnavailable: false, feeReserve: 10, feeRefund: 3,
    wsConnections: 0, dropNotifications: false };
  function notify(quote: Quote) {
    if (state.dropNotifications) return;
    for (const socket of sockets) for (const [subId, subscription] of socket.data.subscriptions) {
      if (subscription.kind === "bolt11_mint_quote" && subscription.filters.includes(quote.quote)) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "subscribe", params: { subId, payload: quote } }));
      }
    }
  }
  const keyset = { id: keys.keysetId, unit: "sat", active: true, input_fee_ppk: 0 };
  const error = (detail: string, code = 10000) => Response.json({ code, detail }, { status: 400 });
  function signOutput(output: Output, amount = output.amount) {
    const signature = createBlindSignature(pointFromHex(output.B_), keys.privKeys[String(amount)]!, keys.keysetId);
    const value = { amount, id: keys.keysetId, C_: signature.C_.toHex(true) };
    signatures.set(output.B_, value);
    return value;
  }
  function validInputs(inputs: Input[]) {
    return inputs.length > 0 && new Set(inputs.map((p) => p.secret)).size === inputs.length && inputs.every((p) =>
      p.id === keys.keysetId && !spent.has(p.secret) && !pending.has(p.secret) && keys.privKeys[String(p.amount)] &&
      verifyUnblindedSignature({ C: pointFromHex(p.C), secret: new TextEncoder().encode(p.secret), id: p.id }, keys.privKeys[String(p.amount)]!));
  }
  function inputFee(inputs: Input[]) { return Math.ceil(inputs.length * keyset.input_fee_ppk / 1000); }
  function settle(quoteId: string) {
    const submission = submissions.find((s) => s.quote.quote === quoteId)!;
    const { quote, inputs, outputs } = submission;
    if (quote.state === "PAID") return;
    const reserve = quote.fee_options.find((f) => f.fee_index === quote.selected_fee_index)!.fee_reserve;
    let change = inputs.reduce((sum, p) => sum + p.amount, 0) - quote.amount - inputFee(inputs) - reserve + Math.min(state.feeRefund, reserve);
    const amounts: number[] = [];
    for (let value = 1; change > 0; value *= 2) { if (change % 2) amounts.push(value); change = Math.floor(change / 2); }
    if (amounts.length > outputs.length) throw new Error("Insufficient change outputs");
    quote.change = amounts.map((amount, i) => signOutput(outputs[i]!, amount));
    inputs.forEach((p) => { pending.delete(p.secret); spent.add(p.secret); });
    quote.state = "PAID";
    quote.outpoint = `${"ab".repeat(32)}:0`;
  }
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/ws" && options.websocket && server.upgrade(request, { data: { subscriptions: new Map() } })) return;
      if (path === "/v1/info") state.infoRequests++;
      if (state.unavailable) return new Response("Unavailable", { status: 503 });
      if (state.quoteStatusUnavailable && request.method === "GET" && /\/v1\/(mint|melt)\/quote\//.test(path)) {
        return new Response("Quote checks unavailable", { status: 503 });
      }
      if (path === "/v1/info") return Response.json(info);
      if (path === "/v1/keysets") return Response.json({ keysets: [keyset] });
      if (path === "/v1/keys" || path === `/v1/keys/${keys.keysetId}`) {
        return Response.json({ keysets: [{ ...keyset, keys: publicKeys }] });
      }
      if (path === "/v1/mint/quote/bolt11" && request.method === "POST") {
        const body = await request.json() as { amount: number; unit: string };
        state.quoteRequests++;
        if (body.unit !== "sat" || !Number.isSafeInteger(body.amount) || body.amount < 1 || body.amount > 10_000) return error("Invalid amount");
        const id = crypto.randomUUID();
        const timestamp = Math.floor(Date.now() / 1000);
        const paymentHash = new Bun.CryptoHasher("sha256").update(id).digest("hex");
        const invoice = sign(encode({
          satoshis: body.amount + state.invoiceAmountOffset,
          timestamp: timestamp - state.invoiceAgeSeconds,
          tags: [
            { tagName: "payment_hash", data: paymentHash },
            { tagName: "description", data: "Cashu mint quote" },
            ...state.omitInvoiceExpiry ? [] : [{ tagName: "expire_time" as const, data: 3600 }],
          ],
        }), invoiceKey).paymentRequest!;
        const quote: Quote = { quote: id, request: invoice, amount: body.amount, unit: "sat", state: "UNPAID", expiry: timestamp + 3600 };
        quotes.set(id, quote);
        return Response.json(quote);
      }
      if (path.startsWith("/v1/mint/quote/bolt11/") && request.method === "GET") {
        const quote = quotes.get(path.split("/").at(-1)!);
        return quote ? Response.json(quote) : error("Unknown quote");
      }
      if (path === "/v1/mint/bolt11" && request.method === "POST") {
        state.issuanceAttempts++;
        const body = await request.json() as { quote: string; outputs: Output[] };
        const quote = quotes.get(body.quote);
        if (!quote || quote.state === "UNPAID") return error("Unpaid quote", 20001);
        if (quote.state === "ISSUED") return error("Already issued", 20002);
        if (state.issuancePaused) return new Response("Issuance paused", { status: 503 });
        if (body.outputs.reduce((sum, output) => sum + output.amount, 0) !== quote.amount ||
            body.outputs.some((output) => output.id !== keys.keysetId || !keys.privKeys[String(output.amount)] || signatures.has(output.B_))) {
          return error("Invalid outputs");
        }
        const signed = body.outputs.map((output) => {
          const signature = createBlindSignature(pointFromHex(output.B_), keys.privKeys[String(output.amount)]!, keys.keysetId);
          const value = { amount: output.amount, id: keys.keysetId, C_: signature.C_.toHex(true) };
          signatures.set(output.B_, value);
          return value;
        });
        quote.state = "ISSUED";
        state.issuanceCount++;
        notify(quote);
        return Response.json({ signatures: signed });
      }
      if (path === "/v1/melt/quote/onchain" && request.method === "POST") {
        if (state.payoutUnavailable) return new Response("Unavailable", { status: 503 });
        const body = await request.json() as { request: string; amount: number; unit: string };
        const limits = info.nuts["5"].methods[0]!;
        if (body.unit !== "sat" || body.amount < limits.min_amount || body.amount > limits.max_amount) return error("Invalid payout amount");
        const quote: MeltQuote = { quote: crypto.randomUUID(), request: body.request, amount: body.amount,
          unit: "sat", expiry: Math.floor(Date.now() / 1000) + 3600, state: "UNPAID", selected_fee_index: null, outpoint: null,
          fee_options: [{ fee_index: 42, fee_reserve: state.feeReserve + 8, estimated_blocks: 1 },
            { fee_index: 7, fee_reserve: state.feeReserve, estimated_blocks: 6 },
            { fee_index: 19, fee_reserve: state.feeReserve + 2, estimated_blocks: 3 }] };
        melts.set(quote.quote, quote);
        return Response.json(quote);
      }
      if (path.startsWith("/v1/melt/quote/onchain/") && request.method === "GET") {
        return Response.json(melts.get(path.split("/").at(-1)!)!);
      }
      if (path === "/v1/swap" && request.method === "POST") {
        const { inputs, outputs } = await request.json() as { inputs: Input[]; outputs: Output[] };
        if (!validInputs(inputs) || inputs.reduce((sum, p) => sum + p.amount, 0) !==
            outputs.reduce((sum, p) => sum + p.amount, 0) + inputFee(inputs)) return error("Invalid swap inputs or fees");
        inputs.forEach((p) => spent.add(p.secret));
        state.swapRequests++;
        return Response.json({ signatures: outputs.map((output) => signOutput(output)) });
      }
      if (path === "/v1/melt/onchain" && request.method === "POST") {
        state.meltAttempts++;
        const body = await request.json() as { quote: string; fee_index: number; inputs: Input[]; outputs: Output[] };
        const quote = melts.get(body.quote);
        const fee = quote?.fee_options.find((f) => f.fee_index === body.fee_index);
        if (!quote || quote.state !== "UNPAID" || !fee || !validInputs(body.inputs) ||
            body.inputs.reduce((sum, p) => sum + p.amount, 0) < quote.amount + fee.fee_reserve + inputFee(body.inputs)) return error("Invalid melt inputs or fees");
        state.meltRequests++;
        quote.selected_fee_index = body.fee_index;
        quote.state = "PENDING";
        body.inputs.forEach((p) => pending.add(p.secret));
        submissions.push({ quote, inputs: body.inputs, outputs: body.outputs ?? [] });
        if (!state.pendingPayouts) settle(quote.quote);
        while (state.holdMeltResponses && !request.signal.aborted) await Bun.sleep(20);
        return Response.json(quote);
      }
      if (path === "/v1/restore" && request.method === "POST") {
        const { outputs } = await request.json() as { outputs: Output[] };
        const known = outputs.filter((output) => signatures.has(output.B_));
        return Response.json({ outputs: known, signatures: known.map((output) => signatures.get(output.B_)) });
      }
      if (path === "/v1/checkstate" && request.method === "POST") {
        const { Ys } = await request.json() as { Ys: string[] };
        return Response.json({ states: Ys.map((Y) => ({ Y, state: [...spent].some((s) => hashToCurve(new TextEncoder().encode(s)).toHex(true) === Y) ? "SPENT" :
          [...pending].some((s) => hashToCurve(new TextEncoder().encode(s)).toHex(true) === Y) ? "PENDING" : "UNSPENT" })) });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(socket) { sockets.add(socket); state.wsConnections++; },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as { id: number; method: string; params: Subscription & { subId: string } };
        const { subId, kind, filters } = message.params;
        if (message.method === "unsubscribe") socket.data.subscriptions.delete(subId);
        else if (message.method === "subscribe") socket.data.subscriptions.set(subId, { kind, filters });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { status: "OK", subId } }));
        if (message.method === "subscribe" && kind === "bolt11_mint_quote") {
          for (const id of filters) { const quote = quotes.get(id); if (quote) notify(quote); }
        }
      },
      close(socket) { sockets.delete(socket); },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    info, state, quotes, melts, keyset, submissions, settle,
    pay(invoice: string) {
      // Exercise a real BOLT11 decoder (including signature recovery), then
      // simulate settlement at the fixture instead of routing a real payment.
      const decoded = decode(invoice);
      const quote = [...quotes.values()].find((quote) => quote.request === invoice);
      if (!quote || decoded.satoshis !== quote.amount) throw new Error("Unknown or mismatched invoice");
      if (quote.state === "UNPAID") { quote.state = "PAID"; notify(quote); }
    },
    verifies(proof: CoreProof) {
      return verifyUnblindedSignature({
        C: pointFromHex(proof.C), secret: new TextEncoder().encode(proof.secret), id: proof.id,
      }, keys.privKeys[proof.amount.toString()]!);
    },
    closeSockets() { for (const socket of sockets) socket.close(1001, "Mint connection closed"); },
    async stop() {
      for (const socket of sockets) socket.terminate();
      const stopped = server.stop(true);
      if (!options.websocket) return stopped;
      // Bun 1.3.14 can retain a phantom pendingWebSockets count after a
      // server-initiated close. The listener and real sockets are closed;
      // do not let its unresolved stop promise hang the integration harness.
      await Promise.race([stopped, Bun.sleep(1000)]);
      if (server.pendingRequests || sockets.size) throw new Error("Mint fixture still has active requests or sockets");
    },
  };
}

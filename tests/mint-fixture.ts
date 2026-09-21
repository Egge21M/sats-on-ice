import { createBlindSignature, createNewMintKeys, pointFromHex, serializeMintKeys, verifyUnblindedSignature } from "@cashu/cashu-ts";
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

export function startMintFixture() {
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
    },
  };
  const state = { unavailable: false, issuancePaused: false, invoiceAmountOffset: 0, invoiceAgeSeconds: 0,
    omitInvoiceExpiry: false, issuanceCount: 0, issuanceAttempts: 0, quoteRequests: 0, infoRequests: 0 };
  const keyset = { id: keys.keysetId, unit: "sat", active: true, input_fee_ppk: 0 };
  const error = (detail: string, code = 10000) => Response.json({ code, detail }, { status: 400 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/info") state.infoRequests++;
      if (state.unavailable) return new Response("Unavailable", { status: 503 });
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
        return Response.json({ signatures: signed });
      }
      if (path === "/v1/restore" && request.method === "POST") {
        const { outputs } = await request.json() as { outputs: Output[] };
        const known = outputs.filter((output) => signatures.has(output.B_));
        return Response.json({ outputs: known, signatures: known.map((output) => signatures.get(output.B_)) });
      }
      if (path === "/v1/checkstate" && request.method === "POST") {
        const { Ys } = await request.json() as { Ys: string[] };
        return Response.json({ states: Ys.map((Y) => ({ Y, state: "UNSPENT" })) });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    info, state, quotes,
    pay(invoice: string) {
      // Exercise a real BOLT11 decoder (including signature recovery), then
      // simulate settlement at the fixture instead of routing a real payment.
      const decoded = decode(invoice);
      const quote = [...quotes.values()].find((quote) => quote.request === invoice);
      if (!quote || decoded.satoshis !== quote.amount) throw new Error("Unknown or mismatched invoice");
      if (quote.state === "UNPAID") quote.state = "PAID";
    },
    verifies(proof: CoreProof) {
      return verifyUnblindedSignature({
        C: pointFromHex(proof.C), secret: new TextEncoder().encode(proof.secret), id: proof.id,
      }, keys.privKeys[proof.amount.toString()]!);
    },
    stop: () => server.stop(true),
  };
}

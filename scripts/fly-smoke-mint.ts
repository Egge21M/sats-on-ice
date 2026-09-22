// Disposable deployment fixture. Never use this mint or its invoices with funds.
// Bundle separately; neither this script nor the fixture enters the app image.
import { startMintFixture } from "../tests/mint-fixture.ts";

const token = process.env.SOI_SMOKE_TOKEN;
if (!token || token.length < 32) throw new Error("Set a random SOI_SMOKE_TOKEN of at least 32 characters.");
const mint = startMintFixture();
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__test/")) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      if (url.pathname === "/__test/pay" && request.method === "POST") {
        const { invoice } = await request.json() as { invoice: string };
        if (![...mint.quotes.values()].some((quote) => quote.request === invoice)) return new Response(null, { status: 404 });
        mint.pay(invoice);
        return Response.json({ paid: true });
      }
      if (url.pathname === "/__test/state" && request.method === "GET") {
        // Includes unsubmitted fee-probe quotes; meltRequests counts submissions.
        return Response.json({ issuanceCount: mint.state.issuanceCount, meltRequests: mint.state.meltRequests,
          payouts: [...mint.melts.values()].map(({ request, state }) => ({ address: request, state })) });
      }
      return new Response(null, { status: 404 });
    }
    return fetch(`${mint.url}${url.pathname}${url.search}`, {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    });
  },
});
console.log("CONTROLLED TEST MINT: simulated payments only; all state is in memory.");
const shutdown = async () => { await server.stop(true); await mint.stop(); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

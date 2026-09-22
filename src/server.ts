import type { RuntimeConfig } from "./config.ts";
import { UserError } from "./errors.ts";
import { fetchMintCapabilities, type MintCapabilities } from "./mint-capabilities.ts";
import { openReceivingWallet } from "./receiving-wallet.ts";
import { openInstance } from "./setup.ts";

type ReceivingWallet = Awaited<ReturnType<typeof openReceivingWallet>>;
export type ReceivingStatus = "validating" | "retrying" | "ready" | "incompatible" | "stopped";

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  } });
}
function failure(reason: string, status: number) { return json({ status: "ERROR", reason }, status); }

function publicHost(request: Request): string {
  const host = request.headers.get("host");
  if (!host || /[\s/@\\?#,%]/.test(host)) throw new UserError("Invalid public Host header.");
  const origin = new URL(`https://${host}`);
  if (!origin.hostname || origin.username || origin.password || origin.pathname !== "/") {
    throw new UserError("Invalid public Host header.");
  }
  return origin.host;
}

export async function startReceivingServer(options: {
  database: string;
  config?: RuntimeConfig;
  hostname?: string;
  port?: number;
  retryDelayMs?: number;
  onStatus?: (status: ReceivingStatus, message: string) => void;
  onPayout?: (message: string) => void;
  /** Internal timing overrides for controlled integration checks. */
  timing?: { pollingIntervalMs?: number; processorIntervalMs?: number };
}) {
  const connection = openInstance(options.database, options.config);
  const { store, config } = connection;
  const { username, mintUrl } = config;
  const discoveryPath = `/.well-known/lnurlp/${username}`;
  const callbackPath = `/lnurlp/${username}/callback`;
  const abort = new AbortController();
  const inFlight = new Set<Promise<Response>>();
  let status: ReceivingStatus = "validating";
  let wallet: ReceivingWallet | undefined;
  let capabilities: MintCapabilities | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let initializing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  function report(next: ReceivingStatus, message: string) {
    status = next;
    options.onStatus?.(next, message);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== discoveryPath && url.pathname !== callbackPath) return failure("Unknown Lightning Address.", 404);
    if (request.method !== "GET") return failure("Use GET for Lightning Address requests.", 405);
    if (status !== "ready" || !wallet || !capabilities) return failure("Receiving is not ready. Please try again later.", 503);
    let host: string;
    try { host = publicHost(request); }
    catch { return failure("Invalid public Host header.", 400); }
    const { min, max } = capabilities.receiving;
    if (url.pathname === discoveryPath) {
      return json({
        tag: "payRequest",
        callback: `https://${host}${callbackPath}`,
        minSendable: min * 1000,
        maxSendable: max * 1000,
        metadata: JSON.stringify([["text/plain", `Payment to ${username}@${host}`]]),
      });
    }
    const amounts = url.searchParams.getAll("amount");
    const raw = amounts[0];
    if (amounts.length !== 1 || !raw || raw.length > 16 || !/^[0-9]+$/.test(raw)) {
      return failure("Specify one integer amount in millisatoshis.", 400);
    }
    const msats = Number(raw);
    if (!Number.isSafeInteger(msats) || msats % 1000 !== 0 || msats < min * 1000 || msats > max * 1000) {
      return failure("Amount must be whole satoshis within the advertised limits.", 400);
    }
    try {
      const invoice = await wallet.createInvoice(msats / 1000);
      return json({ pr: invoice, routes: [] });
    } catch {
      // Mint, SQL and library errors can contain seed/proof material.
      return failure("Unable to prepare a receiving invoice. Please try again later.", 502);
    }
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 3000,
      fetch(request) {
        const response = handle(request).catch(() => failure("Unable to process payment request.", 500));
        inFlight.add(response);
        void response.finally(() => inFlight.delete(response));
        return response;
      },
      error: () => failure("Unable to process payment request.", 500),
    });
  } catch (error) {
    connection.close();
    throw error;
  }

  async function initialize() {
    try {
      report("validating", "Checking mint capabilities and starting receiving.");
      const checked = await fetchMintCapabilities(mintUrl, abort.signal);
      if (abort.signal.aborted) return;
      const opened = await openReceivingWallet(connection.sqlite, async () => store.getSeed(), mintUrl, options.timing, {
        config, limits: checked.payout,
        allocate: () => connection.sqlite.transaction(() => store.allocatePayout(config.destinationId)).immediate(),
        report: (message) => options.onPayout?.(message),
      });
      if (abort.signal.aborted) { await opened.close(); return; }
      wallet = opened;
      capabilities = checked;
      report("ready", `Receiving ready: ${checked.receiving.min}–${checked.receiving.max} sats per invoice. Automatic sweep threshold: ${config.payoutThresholdSats} sats.`);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof UserError) {
        report("incompatible", error.message);
        throw error;
      }
      report("retrying", "Receiving unavailable. Retrying mint validation and wallet startup.");
      retryTimer = setTimeout(() => {
        // Permanent failures discovered after a retry remain unready until restart.
        initializing = initialize().catch(() => {});
      }, options.retryDelayMs ?? 5000);
    }
  }

  function stop(): Promise<void> {
    if (stopping) return stopping;
    abort.abort();
    if (retryTimer) clearTimeout(retryTimer);
    report("stopped", "Receiving stopped.");
    stopping = (async () => {
      await server.stop(true);
      await initializing?.catch(() => {});
      await Promise.allSettled(inFlight);
      try { await wallet?.close(); }
      finally { connection.close(); }
    })();
    return stopping;
  }

  initializing = initialize();
  try { await initializing; }
  catch (error) { await stop(); throw error; }
  return { port: server.port!, get status() { return status; }, stop };
}

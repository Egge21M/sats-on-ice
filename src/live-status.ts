import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { Socket, createServer } from "node:net";
import { z } from "zod";
import { activeConfigSchema } from "./config.ts";

const liveStatusSchema = z.object({
  startedAt: z.string(), observedAt: z.string(),
  config: activeConfigSchema.omit({ nextPayoutIndex: true }),
  readiness: z.enum(["validating", "retrying", "ready", "incompatible", "stopped"]),
  readinessObservedAt: z.string(), message: z.string(),
  lastPayout: z.object({ observedAt: z.string(), message: z.string() }).nullable(),
  lastInvoiceError: z.object({ observedAt: z.string(), message: z.string() }).nullable(),
});
export type LiveStatus = z.infer<typeof liveStatusSchema>;

function socketPath(database: string) { return `${realpathSync(database)}.status/server.sock`; }

/** One response per connection; no commands and no mint requests. */
export async function serveLiveStatus(database: string, snapshot: () => LiveStatus) {
  const path = socketPath(database);
  const directory = `${realpathSync(database)}.status`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  try {
    if (!lstatSync(path).isSocket()) throw new Error("Status path is not a socket.");
    // Only reclaim a socket whose previous listener is gone, never a live one.
    const code = await new Promise<string>((resolve) => {
      const probe = new Socket();
      const done = (value: string) => { probe.destroy(); resolve(value); };
      probe.once("connect", () => done("active"));
      probe.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "unknown"));
      probe.setTimeout(500, () => done("timeout"));
      probe.connect(path);
    });
    if (code !== "ECONNREFUSED") throw new Error("Status socket is already in use or unavailable.");
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.setTimeout(1000, () => socket.destroy());
    socket.end(JSON.stringify(snapshot()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  server.on("error", () => {});
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A timeout/missing socket says nothing about whether the server is stopped or suspended. */
export async function readLiveStatus(database: string): Promise<LiveStatus | null> {
  let path: string;
  try { path = socketPath(database); } catch { return null; }
  return new Promise((resolve) => {
    const socket = new Socket();
    let data = "";
    const timer = setTimeout(() => finish(null), 2000);
    function finish(value: LiveStatus | null) { clearTimeout(timer); socket.destroy(); resolve(value); }
    socket.setEncoding("utf8");
    socket.on("error", () => finish(null));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 65536) finish(null);
    });
    socket.on("end", () => {
      try {
        const parsed = liveStatusSchema.safeParse(JSON.parse(data));
        finish(parsed.success ? parsed.data : null);
      } catch { finish(null); }
    });
    socket.connect(path);
  });
}

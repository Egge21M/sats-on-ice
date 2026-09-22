import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveStatus, serveLiveStatus, type LiveStatus } from "../src/live-status.ts";
import { SETUP, XPUB } from "./fixtures.ts";

let directory: string;
let database: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "soi-live-"));
  database = join(directory, "wallet.sqlite");
  writeFileSync(database, "");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const observedAt = new Date().toISOString();
const snapshot: LiveStatus = { startedAt: observedAt, observedAt, readinessObservedAt: observedAt,
  config: { ...SETUP, destinationKey: XPUB, identityId: 1, destinationId: 1 },
  readiness: "retrying", message: "Retrying mint validation.", lastPayout: null, lastInvoiceError: null };

test("private local listener reports captured state, survives another listener attempt and disappears on close", async () => {
  const listener = await serveLiveStatus(database, () => snapshot);
  try {
    expect(statSync(`${database}.status`).mode & 0o777).toBe(0o700);
    expect(await readLiveStatus(database)).toEqual(snapshot);
    await expect(serveLiveStatus(database, () => ({ ...snapshot, readiness: "ready" }))).rejects.toThrow("already in use");
    expect((await readLiveStatus(database))?.readiness).toBe("retrying");
  } finally { await listener.close(); }
  expect(await readLiveStatus(database)).toBeNull();
});

test("a hung local listener times out and an invalid response never establishes readiness", async () => {
  const listener = await serveLiveStatus(database, () => snapshot);
  await listener.close();
  let respond = false;
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    if (respond) socket.end('{"readiness":"ready"}');
  });
  await new Promise<void>((resolve) => server.listen(`${database}.status/server.sock`, resolve));
  try {
    const started = Date.now();
    expect(await readLiveStatus(database)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3500);
    respond = true;
    expect(await readLiveStatus(database)).toBeNull();
  } finally {
    clients.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

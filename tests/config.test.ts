import { describe, expect, test } from "bun:test";
import { normalizeMintUrl } from "@cashu/coco-core";
import { HDKey } from "@scure/bip32";
import { mintUrlSchema, runtimeConfigSchema, thresholdArgumentSchema, readRuntimeConfig } from "../src/config.ts";
import { derivePayoutAddress, normalizeDestinationKey } from "../src/destination.ts";
import { FIRST_ADDRESS, SECOND_ADDRESS, SETUP, XPUB, ZPUB } from "./fixtures.ts";

describe("destination account", () => {
  test("xpub and zpub reproduce both published BIP84 receiving addresses", () => {
    for (const key of [XPUB, ZPUB]) {
      expect(derivePayoutAddress(key, 0)).toBe(FIRST_ADDRESS);
      expect(derivePayoutAddress(key, 1)).toBe(SECOND_ADDRESS);
      expect(normalizeDestinationKey(key)).toBe(XPUB);
    }
  });

  test("rejects checksum errors, private keys, testnet, unsupported versions and wrong export levels", () => {
    const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
    const account = root.derive("m/84'/0'/0'");
    const testnet = HDKey.fromMasterSeed(new Uint8Array(32).fill(1), { public: 0x043587cf, private: 0x04358394 }).derive("m/84'/1'/0'");
    const ypub = HDKey.fromMasterSeed(new Uint8Array(32).fill(1), { public: 0x049d7cb2, private: 0x049d7878 }).derive("m/49'/0'/0'");
    const invalid = [
      XPUB.slice(0, -1) + "1", "xpub-invalid", account.privateExtendedKey,
      root.publicExtendedKey, account.deriveChild(0).publicExtendedKey,
      root.derive("m/84'/0'/0").publicExtendedKey,
      testnet.publicExtendedKey, ypub.publicExtendedKey,
    ];
    for (const destinationKey of invalid) {
      // Use booleans so a failed assertion never prints a private-key input.
      expect(runtimeConfigSchema.safeParse({ ...SETUP, destinationKey }).success).toBe(false);
    }
  });

  test.each([-1, 0.5, 0x80000000, NaN])("rejects invalid payout index %s", (index) => {
    expect(() => derivePayoutAddress(XPUB, index)).toThrow("Payout index");
  });
});

describe("configuration validation", () => {
  test("normalizes mint URL and destination serialization", () => {
    expect(runtimeConfigSchema.parse({ ...SETUP, mintUrl: "https://MINT.example:443/" })).toEqual({ ...SETUP, destinationKey: XPUB });
  });

  test.each([
    ["https://MINT.example:443///", "https://mint.example"],
    ["https://mint.example/old/../cashu///", "https://mint.example/cashu"],
    ["https://mint.example/a//b///", "https://mint.example/a//b"],
    ["http://localhost:3338//", "http://localhost:3338"],
    ["http://127.0.0.1:3338/cashu//", "http://127.0.0.1:3338/cashu"],
  ])("mint URL normalization is stable for %s", (input, expected) => {
    const normalized = mintUrlSchema.parse(input);
    expect(normalized).toBe(expected);
    expect(mintUrlSchema.parse(normalized)).toBe(normalized);
    expect(normalizeMintUrl(normalized)).toBe(normalized);
  });

  test.each(["", "Alice", "@alice", "../alice", "a b", "a".repeat(65)])("rejects invalid username %s", (username) => {
    expect(runtimeConfigSchema.safeParse({ ...SETUP, username }).success).toBe(false);
  });

  test.each(["mint.example", "ftp://mint.example", "https://user:password@mint.example", "https://mint.example?q=1", "https://mint.example/#x", "https://mint.example/?", "https://mint.example/#"])("rejects invalid mint URL %s", (mintUrl) => {
    expect(runtimeConfigSchema.safeParse({ ...SETUP, mintUrl }).success).toBe(false);
  });

  test.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1000", true])("rejects invalid threshold %s", (payoutThresholdSats) => {
    expect(runtimeConfigSchema.safeParse({ ...SETUP, payoutThresholdSats }).success).toBe(false);
  });

  test("environment accepts integer sats without permissive numeric coercion", () => {
    expect(thresholdArgumentSchema.parse("1000")).toBe(1000);
    expect(thresholdArgumentSchema.parse(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of ["", "0", "-1", "1.5", "1e3", "0x10", " 1", "true", "9007199254740992"]) {
      expect(thresholdArgumentSchema.safeParse(value).success).toBe(false);
    }
  });
});


test("runtime policy is required from env while identity overrides are optional and normalized", () => {
  const policy = { SOI_MINT_URL: "https://MINT.example///", SOI_PAYOUT_THRESHOLD_SATS: "1000" };
  expect(readRuntimeConfig(policy)).toEqual({ mintUrl: "https://mint.example", payoutThresholdSats: 1000, username: undefined, destinationKey: undefined });
  expect(readRuntimeConfig({ ...policy, SOI_USERNAME: "alice", SOI_XPUB: ZPUB }).destinationKey).toBe(XPUB);
  for (const key of ["SOI_MINT_URL", "SOI_PAYOUT_THRESHOLD_SATS"]) {
    const missing: Record<string, string> = { ...policy };
    delete missing[key];
    expect(() => readRuntimeConfig(missing)).toThrow();
  }
  expect(() => readRuntimeConfig({ ...policy, SOI_USERNAME: "" })).toThrow();
  expect(() => readRuntimeConfig({ ...policy, SOI_XPUB: "" })).toThrow();
});

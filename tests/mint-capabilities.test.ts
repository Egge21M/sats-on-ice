import { expect, test } from "bun:test";
import { MAX_RECEIVING_SATS, parseMintCapabilities } from "../src/mint-capabilities.ts";

function info(receiving: Record<string, unknown> = {}, payout: Record<string, unknown> = {}) {
  return { nuts: {
    "4": { disabled: false, methods: [{ method: "bolt11", unit: "sat", ...receiving }] },
    "5": { disabled: false, methods: [{ method: "onchain", unit: "sat", ...payout }] },
  } };
}

test("missing or null limits use the exact LNURL numeric range; mint limits bound both payment methods", () => {
  expect(parseMintCapabilities(info({ min_amount: null, max_amount: null }))).toEqual({
    receiving: { min: 1, max: MAX_RECEIVING_SATS }, payout: { min: 1, max: Number.MAX_SAFE_INTEGER },
  });
  expect(parseMintCapabilities(info({ min_amount: 10, max_amount: 1000 }, { min_amount: 500, max_amount: 1_000_000 }))).toEqual({
    receiving: { min: 10, max: 1000 }, payout: { min: 500, max: 1_000_000 },
  });
  expect(Number.isSafeInteger(MAX_RECEIVING_SATS * 1000)).toBe(true);
});

test.each([
  { method: "bolt12" }, { unit: "usd" }, { min_amount: -1 }, { max_amount: 0 },
  { min_amount: 1.5 }, { max_amount: "100" }, { min_amount: 100, max_amount: 10 },
  { min_amount: MAX_RECEIVING_SATS + 1 }, { max_amount: Number.MAX_SAFE_INTEGER + 1 },
])("rejects incompatible Lightning receiving settings: %j", (settings) => {
  expect(() => parseMintCapabilities(info(settings))).toThrow();
});

test.each([{ method: "bolt11" }, { unit: "msat" }, { min_amount: 1000, max_amount: 100 }, { max_amount: -1 }])(
  "rejects incompatible on-chain payout settings: %j", (settings) => {
    expect(() => parseMintCapabilities(info({}, settings))).toThrow();
  },
);

test("disabled, missing or ambiguous payment metadata is incompatible", () => {
  for (const nut of ["4", "5"] as const) {
    const disabled = info();
    disabled.nuts[nut].disabled = true;
    expect(() => parseMintCapabilities(disabled)).toThrow();
    const duplicate = info();
    duplicate.nuts[nut].methods.push(duplicate.nuts[nut].methods[0]!);
    expect(() => parseMintCapabilities(duplicate)).toThrow();
  }
  for (const value of [null, {}, { nuts: {} }, { nuts: { "4": { disabled: false, methods: [] } } }]) {
    expect(() => parseMintCapabilities(value)).toThrow();
  }
});

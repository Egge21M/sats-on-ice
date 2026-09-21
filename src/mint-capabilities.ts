import { z } from "zod";
import { UserError } from "./errors.ts";

export class IncompatibleMintError extends UserError {}

const methodSchema = z.object({
  method: z.string(),
  unit: z.string(),
  min_amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  max_amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
});
const nutSchema = z.object({ disabled: z.boolean(), methods: z.array(z.unknown()) });
const infoSchema = z.object({ nuts: z.record(z.string(), z.unknown()) });

export interface AmountLimits { min: number; max: number }
export interface MintCapabilities { receiving: AmountLimits; payout: AmountLimits }

// LNURL amounts are JSON numbers in millisatoshis. Keep conversion exact.
export const MAX_RECEIVING_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

export function parseMintCapabilities(info: unknown): MintCapabilities {
  const parsed = infoSchema.safeParse(info);
  if (!parsed.success) throw new IncompatibleMintError("Mint information is invalid or missing payment capabilities.");
  const nuts = parsed.data.nuts;
  function limits(nut: "4" | "5", method: "bolt11" | "onchain", maximum: number): AmountLimits {
    const settings = nutSchema.safeParse(nuts[nut]);
    if (!settings.success || settings.data.disabled) {
      throw new IncompatibleMintError(`Mint must enable NUT-0${nut} ${method} payments in sats.`);
    }
    const candidates = settings.data.methods.filter((entry) =>
      entry !== null && typeof entry === "object" && "method" in entry && "unit" in entry &&
      entry.method === method && entry.unit === "sat");
    const selected = methodSchema.safeParse(candidates.length === 1 ? candidates[0] : undefined);
    if (!selected.success) throw new IncompatibleMintError(`Mint must advertise valid ${method}/sat limits in NUT-0${nut}.`);
    const min = Math.max(1, selected.data.min_amount ?? 1);
    const max = Math.min(maximum, selected.data.max_amount ?? maximum);
    if (min > max) throw new IncompatibleMintError(`Mint ${method}/sat amount limits have no supported positive range.`);
    return { min, max };
  }
  return { receiving: limits("4", "bolt11", MAX_RECEIVING_SATS), payout: limits("5", "onchain", Number.MAX_SAFE_INTEGER) };
}

export async function fetchMintCapabilities(mintUrl: string, signal: AbortSignal): Promise<MintCapabilities> {
  // Read fresh metadata: Coco may serve cached mint information after reopening.
  const response = await fetch(`${mintUrl}/v1/info`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error("Unable to fetch mint capabilities.");
  let info: unknown;
  try { info = await response.json(); }
  catch { throw new IncompatibleMintError("Mint returned invalid information."); }
  return parseMintCapabilities(info);
}

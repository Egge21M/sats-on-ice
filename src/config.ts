import { z } from "zod";
import { derivePayoutAddress, normalizeDestinationKey } from "./destination.ts";

export const usernameSchema = z.string().regex(
  /^[a-z0-9][a-z0-9._-]{0,63}$/,
  "Use 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
);

export const mintUrlSchema = z.url({
  protocol: /^https?$/,
  normalize: true,
  error: "Use an absolute HTTP(S) mint URL without credentials, query or fragment.",
}).transform((value, ctx) => {
  const url = new URL(value);
  if (url.username || url.password || value.includes("?") || value.includes("#")) {
    ctx.addIssue({ code: "custom", message: "Use an absolute HTTP(S) mint URL without credentials, query or fragment." });
    return z.NEVER;
  }
  // Remove every trailing slash so repeated validation and Coco agree on the mint.
  return value.replace(/\/+$/, "");
});

export const destinationKeySchema = z.string().transform((value, ctx) => {
  try {
    const key = normalizeDestinationKey(value);
    derivePayoutAddress(key, 0);
    return key;
  } catch {
    ctx.addIssue({ code: "custom", message: "Use a Bitcoin mainnet native SegWit account xpub or zpub (depth 3, hardened account)." });
    return z.NEVER;
  }
});

export const payoutThresholdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const thresholdArgumentSchema = z.string().regex(/^\d+$/, "Threshold must be whole satoshis written as digits.")
  .transform(Number).pipe(payoutThresholdSchema);

export const runtimeConfigSchema = z.object({
  username: usernameSchema.optional(),
  mintUrl: mintUrlSchema,
  destinationKey: destinationKeySchema.optional(),
  payoutThresholdSats: payoutThresholdSchema,
}).strict();

export const activeConfigSchema = runtimeConfigSchema.extend({
  username: usernameSchema,
  destinationKey: destinationKeySchema,
  identityId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  destinationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // 2^31 means the unhardened sequence is exhausted, not a derivable address.
  nextPayoutIndex: z.number().int().min(0).max(0x80000000),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type ActiveConfig = z.infer<typeof activeConfigSchema>;

const environmentSchema = z.object({
  SOI_USERNAME: usernameSchema.optional(),
  SOI_XPUB: destinationKeySchema.optional(),
  SOI_MINT_URL: mintUrlSchema,
  SOI_PAYOUT_THRESHOLD_SATS: thresholdArgumentSchema,
});

export function readRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const values = environmentSchema.parse(env);
  return {
    username: values.SOI_USERNAME,
    destinationKey: values.SOI_XPUB,
    mintUrl: values.SOI_MINT_URL,
    payoutThresholdSats: values.SOI_PAYOUT_THRESHOLD_SATS,
  };
}

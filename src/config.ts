import { normalizeMintUrl } from "@cashu/coco-core";
import { z } from "zod";
import { derivePayoutAddress, normalizeDestinationKey } from "./destination.ts";

export const usernameSchema = z.string().regex(
  /^[a-z0-9][a-z0-9._-]{0,63}$/,
  "Use 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
);

export const mintUrlSchema = z.string().transform((value, ctx) => {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    return normalizeMintUrl(url.href);
  } catch {
    ctx.addIssue({ code: "custom", message: "Use an absolute HTTP(S) mint URL without credentials, query or fragment." });
    return z.NEVER;
  }
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

export const setupSchema = z.object({
  username: usernameSchema,
  mintUrl: mintUrlSchema,
  destinationKey: destinationKeySchema,
  payoutThresholdSats: payoutThresholdSchema,
}).strict();

export const storedConfigSchema = setupSchema.extend({
  // 2^31 means the unhardened sequence is exhausted, not a derivable address.
  nextPayoutIndex: z.number().int().min(0).max(0x80000000),
});

export type SetupInput = z.infer<typeof setupSchema>;
export type StoredConfig = z.infer<typeof storedConfigSchema>;

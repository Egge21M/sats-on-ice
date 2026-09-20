import { HARDENED_OFFSET, HDKey } from "@scure/bip32";
import { p2wpkh } from "@scure/btc-signer";
import { UserError } from "./errors.ts";

const ZPUB_VERSIONS = { public: 0x04b24746, private: 0x04b2430c };
const XPUB_VERSIONS = { public: 0x0488b21e, private: 0x0488ade4 };
const KEY_ERROR = "Use a Bitcoin mainnet native SegWit account xpub or zpub (depth 3, hardened account). Private keys and other key formats are unsupported.";

function parseAccount(key: string): HDKey {
  try {
    const versions = key.startsWith("zpub") ? ZPUB_VERSIONS : XPUB_VERSIONS;
    if (!key.startsWith("xpub") && !key.startsWith("zpub")) throw new Error();
    const account = HDKey.fromExtendedKey(key, versions);
    if (account.privateKey || !account.publicKey || account.depth !== 3 || account.index < HARDENED_OFFSET) {
      throw new Error();
    }
    return account;
  } catch {
    throw new UserError(KEY_ERROR);
  }
}

/** Canonical serialization makes equivalent xpub/zpub inputs compare equal. */
export function normalizeDestinationKey(key: string): string {
  const account = parseAccount(key);
  return new HDKey({
    publicKey: account.publicKey!,
    chainCode: account.chainCode!,
    depth: account.depth,
    index: account.index,
    parentFingerprint: account.parentFingerprint,
    versions: XPUB_VERSIONS,
  }).publicExtendedKey;
}

export function derivePayoutAddress(key: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new UserError("Payout index must be an unhardened integer between 0 and 2147483647.");
  }
  const branch = parseAccount(key).deriveChild(0);
  const child = branch.deriveChild(index);
  // BIP32 can skip invalid children. Never silently allocate a different index.
  if (branch.index !== 0 || child.index !== index) {
    throw new UserError("This payout index cannot be derived; no address was allocated.");
  }
  return p2wpkh(child.publicKey!).address!;
}

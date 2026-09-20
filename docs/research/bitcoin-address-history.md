# Deriving Bitcoin addresses and checking history with TypeScript and Bun

Researched 2026-09-19. Scope: public-key address derivation, history lookup and address allocation. No user wallet data or live history service was queried.

Product decision, 2026-09-19: Sats on Ice will derive payout addresses sequentially from persisted state and will not query address history or check account reuse. The history-service recommendations below document the investigated alternatives, not the selected architecture; see [the address-allocation decision](../adr/0002-sequential-payout-addresses-without-history-lookups.md).

## Recommendation

Use local address derivation plus an indexed Bitcoin history service. Electrum is suitable, but an Esplora HTTP endpoint is simpler if the application only needs to check whether an address has history. In TypeScript, `@scure/btc-signer/net.js` provides an `EsploraProvider` with a direct `txCount(address)` method. Plain Bun `fetch` also suffices. Prefer Electrum when persistent subscriptions or an existing Electrum server are useful. This recommendation follows the API capabilities below, rather than a benchmark.

For this Bun project, my first choice for the small watch-only feature is `@scure/bip32` plus `@scure/btc-signer`, with that optional Esplora helper. BitcoinJS's `bip32` + `tiny-secp256k1` + `bitcoinjs-lib` is also viable. Both derivation stacks passed the local checks below. Neither stack eliminates the need for application-owned allocation state.

## Derivation libraries and required wallet metadata

An extended public key can derive non-hardened child public keys without any private key. It cannot derive hardened children. For a standard native SegWit account, export the account public key at `m/84'/0'/0'` and derive relative paths `0/0`, `0/1`, etc. A master xpub cannot cross those initial hardened steps. If the exported key is already at the receiving branch, derive only the index. [BIP32 public derivation](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki#public-parent-key--public-child-key), [BIP84 path](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki#public-key-derivation).

Key derivation and address construction are distinct steps:

| Stack | Key derivation | Address and script construction |
| --- | --- | --- |
| Scure | `HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index)` | `p2wpkh(publicKey)` returns a native SegWit address and script. [BIP32 API](https://github.com/paulmillr/scure-bip32), [payment API](https://github.com/paulmillr/scure-btc-signer#p2wpkh-witness-public-key-hash). |
| BitcoinJS | `BIP32Factory(ecc).fromBase58(xpub).derive(0).derive(index)` | `payments.p2wpkh({ pubkey })`; use `tiny-secp256k1` for `ecc`. [BIP32 API](https://github.com/bitcoinjs/bip32), [address examples](https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/test/integration/addresses.spec.ts). |

A bare xpub does not specify the intended script type or full origin path. Configuration must identify the network, exported-key level, branch and address type. A descriptor such as `wpkh([FINGERPRINT/84h/0h/0h]xpub.../0/*)` expresses the native SegWit policy and derivation explicitly; the bracketed path records the origin rather than requesting hardened derivation from the xpub. `@bitcoinerlab/descriptors` is a TypeScript option if accepting descriptors becomes a requirement; it was not runtime-tested here. [BIP380](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki), [descriptor library](https://github.com/bitcoinerlab/descriptors).

`ypub` and `zpub` use alternate serialization versions associated with nested and native SegWit respectively. The default Bitcoin-mainnet xpub parser need not accept them. Pass the correct version parameters or decode/re-encode the version bytes with checksum validation while preserving the script policy; never replace the visible prefix as text. [SLIP132 registry](https://github.com/satoshilabs/slips/blob/master/slip-0132.md), [Scure version parameters](https://github.com/paulmillr/scure-bip32).

Example for a **mainnet, native SegWit account xpub**; this policy must match the originating wallet:

```ts
import { HDKey } from '@scure/bip32';
import { p2wpkh } from '@scure/btc-signer';

function deriveReceiveAddress(accountXpub: string, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error('Expected a non-hardened address index');
  }
  const account = HDKey.fromExtendedKey(accountXpub);
  if (account.privateKey || account.depth !== 3) {
    throw new Error('Expected an account-level extended public key');
  }
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error('Missing public key');
  const { address, script } = p2wpkh(child.publicKey);
  return { index, address, script };
}
```

The depth check does not prove the key's origin or script policy. Import those explicitly and compare a derived address with the source wallet before using the configuration.

## Correct meaning of unused

Electrum's `blockchain.scripthash.get_history` returns confirmed transactions followed by current mempool transactions. An empty successful result means the server currently knows no history for that script. `get_balance` and `listunspent` cannot establish this: an address that received and then spent funds can have zero balance and no UTXOs. BIP44 explicitly bases discovery on history rather than balances. [Electrum history, balance and UTXO methods](https://electrumx.readthedocs.io/en/latest/protocol-methods.html#blockchain-scripthash-get-history), [BIP44 discovery](https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki#account-discovery).

This is an observation, not proof of “never used anywhere.” Inference from the API contract: current chain plus current mempool does not preserve every dropped transaction, invoice assignment, or address shown by another wallet. Errors and timeouts must remain “unknown,” not become “unused.” Any known history can conservatively disqualify an address even if its only output had zero value.

## Electrum integration

Electrum indexes the locking script, not the address text or public key. Compute SHA256 of the binary `scriptPubKey`, reverse the digest bytes, then hex-encode. For a script obtained from an address library:

```ts
import { createHash } from 'node:crypto';

function electrumScriptHash(scriptPubKey: Uint8Array): string {
  return createHash('sha256').update(scriptPubKey).digest().reverse().toString('hex');
}
```

Electrum uses JSON-RPC over TCP/TLS or WebSockets; TCP/TLS messages are newline-delimited. Negotiate the protocol using `server.version`, keep a connection alive, and bound concurrency/batch sizes because servers limit responses. [Electrum protocol basics](https://electrumx.readthedocs.io/en/latest/protocol-basics.html).

`blockchain.scripthash.subscribe` can notify about history changes; protocol status is `null` when no history exists. Subscriptions make sense for monitoring issued addresses. For a one-time discovery pass, `get_history` is straightforward and avoids accumulating subscriptions. [Subscription method](https://electrumx.readthedocs.io/en/latest/protocol-methods.html#blockchain-scripthash-subscribe), [status semantics](https://electrumx.readthedocs.io/en/latest/protocol-basics.html#status).

| Client | Evidence and assessment |
| --- | --- |
| `@mempool/electrum-client` | Practical Bitcoin candidate. Source exposes history requests, batching, subscriptions and reconnect logic. Mempool's backend still pins `1.1.9`. CommonJS JavaScript, no dependencies or bundled TypeScript declarations in its manifest. Current use is stronger evidence than assuming active maintenance from its name. [Client source](https://github.com/mempool/electrum-client/blob/master/index.js), [manifest](https://github.com/mempool/electrum-client/blob/master/package.json), [consumer](https://github.com/mempool/mempool/blob/master/backend/package.json). |
| `electrum-client` | Original Node client documents TCP/TLS and subscriptions, but its README example negotiates protocol `1.0`. No Bun support claim or maintenance assurance established; prefer the reviewed fork if choosing this family. [Repository](https://github.com/you21979/node-electrum-client). |
| `@electrum-cash/network` | Typed documentation, TLS, negotiation, keepalive, requests and subscriptions. Current project documentation points to Bitcoin Cash methods and BCH hosts. Generic overlapping RPC calls may work against BTC, but BTC/Bun compatibility was not demonstrated; not the first recommendation for this project. [Official docs](https://electrum-cash.gitlab.io/network/). |

The mempool client uses Node `net`, `tls` and `events`; Bun supports these APIs with documented TLS limitations, so compatibility is plausible, not proven by source inspection alone. Its source also uses `msg.result || msg`, which replaces a legitimate `null` subscription result with the response object. Empty history arrays are unaffected. A typed adapter and targeted runtime verification are appropriate before adoption. [Client transport source](https://github.com/mempool/electrum-client/blob/master/lib/client.js), [Bun compatibility](https://bun.sh/docs/runtime/nodejs-compat).

## Esplora alternative

`GET /address/:address` returns `chain_stats.tx_count` and `mempool_stats.tx_count`. Both zero means no history observed. This requires one HTTP request without retrieving all transactions or calculating Electrum script hashes. The same response includes received/spent output statistics. [Esplora API](https://github.com/Blockstream/esplora/blob/master/API.md#addresses).

The installed `@scure/btc-signer@2.4.1` source and declarations confirm this typed shortcut:

```ts
import { EsploraProvider } from '@scure/btc-signer/net.js';

// Supply an Esplora endpoint for the same Bitcoin network as the address.
const history = new EsploraProvider(fetch, esploraBaseUrl);
const noHistoryObserved = (await history.txCount(address, {
  signal: AbortSignal.timeout(10_000),
})) === 0;
```

`txCount` calls `balance`, which validates and sums confirmed plus mempool transaction counts. The optional network helper accepts a caller-owned fetch transport and retries transient GET failures; the core signer stays offline. This is a history-count check even though its implementation internally calls a method named `balance`. [Official network documentation](https://github.com/paulmillr/scure-btc-signer#network), [implementation](https://raw.githubusercontent.com/paulmillr/scure-btc-signer/main/src/net.ts). This research inspected the implementation; it did not perform a live HTTP query.

## Discovery and issuing addresses

BIP44 uses external branch `0`, internal/change branch `1`, and a discovery gap of 20 consecutive addresses without history. The gap is a recovery convention, not a mathematical guarantee that later addresses are unused. [BIP44](https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki#address-gap-limit).

Application design implication: reserve each derivation index durably and atomically before showing its address. Track issued/reserved and observed-used separately; persist a next index and never recycle expired unpaid invoices merely because history is empty. Coordinate allocation with any other service using the same account, or use a dedicated account. Many unpaid addresses can exceed a restoring wallet's discovery gap, so retain allocation metadata and plan recovery accordingly.

The queried server sees the scripts/addresses and can associate a scan. Deriving locally avoids giving it the xpub, but does not make the lookup private. A trusted self-hosted indexer avoids disclosing those queries to an external operator. This is an inference from what the documented APIs transmit.

## Local verification and limits

Ran isolated smoke checks on Bun **1.3.14**, installing packages into a temporary directory rather than this project's dependencies:

| Package | Tested version |
| --- | --- |
| `bip32` | `5.0.1` |
| `bitcoinjs-lib` | `7.0.2` |
| `tiny-secp256k1` | `2.2.4` |
| `@scure/bip32` | `2.4.0` |
| `@scure/btc-signer` | `2.4.1` |

Both stacks parsed the public BIP84 account fixture, derived receiving indices 0 and 1 and change index 0, and reproduced all three published addresses. Their output scripts also matched. Checks covered explicit zpub version parameters and equivalent xpub serialization, and both stacks rejected hardened derivation from the public key. [Official test vectors](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki#test-vectors).

The Scure `EsploraProvider` imported and ran under Bun with an injected mock HTTP transport. Cases confirmed that `txCount` includes confirmed and mempool history, remains nonzero for a previously funded and fully spent address, and rejects an unsuccessful lookup rather than returning zero. A bounded abort also interrupted retries. These checks establish the exercised runtime behavior, not live-server compatibility or a full library audit. Electrum TCP/TLS and reconnect behavior remain untested.

Temporary verification scripts: `/tmp/sats-on-ice-bitcoin-research-z5eucc/derive-smoke.ts` and `/tmp/sats-on-ice-bitcoin-research-z5eucc/esplora-smoke.ts`. The fixture is public test data and must never be used to receive funds.

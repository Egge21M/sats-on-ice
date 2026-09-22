# Lightning Address receipts through Cashu to an on-chain wallet

Researched 2026-09-19. Scope: feasibility and current public APIs for a self-hosted Lightning Address service that accumulates Cashu ecash and pays an xpub-derived Bitcoin address. No live mint was queried, no payments were made, and no dependencies were installed.

Implementation follow-up, 2026-09-20: [PR #9](https://github.com/Egge21M/sats-on-ice/pull/9) selects and tests the [local setup dependencies and lifecycle](../design/local-setup.md), including Coco core/Bun adapter 2.0.0, Commander, Drizzle and Zod. That baseline used explicit `Manager` construction because `initializeCoco()` performs recovery even when background workers are disabled; the payment examples below concern the future server. The original research remains background for live mint integration, which this PR does not verify.

## Finding

The proposed flow has documented protocol and library support. On-chain melting is now optional **NUT-30**, an extension of Cashu's general mint/melt protocols. It is not merely a proposed private API. The official implementation matrix lists `cdk-mintd` for mint-side support, and CDK, cashu-ts, and Cashu.me for wallet-side support. Actual support remains dependent on the selected mint deployment. [Cashu specification index](https://github.com/cashubtc/nuts), [NUT-30](https://github.com/cashubtc/nuts/blob/main/30.md).

Coco's maintained repository is `cashubtc/coco`. The current package names are `@cashu/coco-core` and, for this Bun application, `@cashu/coco-sqlite-bun`; the latter uses `bun:sqlite`. `@cashu/coco-sqlite` is the separate Node adapter using `better-sqlite3`. The core exposes built-in `bolt11`, `bolt12`, and `onchain` operation methods. [Coco repository](https://github.com/cashubtc/coco), [core README](https://github.com/cashubtc/coco/blob/master/packages/core/README.md).

## Receiving and recovering Lightning payments

A Lightning Address resolves through `/.well-known/lnurlp/<username>` into an LNURL-pay metadata response and callback. The callback receives an amount in **millisatoshis** and returns a BOLT11 invoice. The current base specification requires the payer to verify that invoice amount. [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md), [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md).

Cashu BOLT11 mint quotes supply an invoice in `request`; after its payment, the wallet can redeem the quote for ecash. The protocol separately reports money paid and ecash issued. [NUT-23](https://github.com/cashubtc/nuts/blob/main/23.md).

Coco's current stable mint-operation documentation uses this sequence:

```ts
const quote = await coco.quotes.mint.create({
  mintUrl,
  method: 'bolt11',
  amount: amountSats,
});
const operation = await coco.ops.mint.prepare({ quote, amount: amountSats });
// The LNURL callback returns operation.request as its invoice.
```

Quote creation persists canonical quote state; preparation creates a durable issuance operation. Default watchers/processors monitor payment and redeem it. `initializeCoco()` performs startup recovery; `ops.mint.refresh(id)` and `finalize(id)` support explicit reconciliation. Quote identities use `{ mintUrl, quoteId }`, and `ops.mint.listByQuote(...)` retrieves related operations. [Mint operations](https://cashubtc.github.io/coco/pages/mint-operations.html).

Inference for this application: persist its receipt-to-operation mapping before returning the invoice, and define how sat-only mint quotes handle LNURL's millisatoshi input. Do not silently round a payer's requested amount. Payment into the mint and successful local ecash issuance are distinct events.

## Balance and on-chain payout

`coco.wallet.balances.byMint()` and `total()` expose balances; the core also documents unit-scoped queries and separate spendable/reserved amounts. Coco needs an application-supplied seed and durable repositories; it does not persist that seed itself. [Core README](https://github.com/cashubtc/coco/blob/master/packages/core/README.md), [initialization and seed handling](https://cashubtc.github.io/coco/starting/start-here.html).

Current payout documentation gives:

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'onchain',
  methodData: { address, amountSats },
});
const prepared = await coco.ops.melt.prepare({
  quote,
  feeIndex: selectedFeeIndex,
});
const result = await coco.ops.melt.execute(prepared.id);
```

Choose `selectedFeeIndex` from the quote's advertised options. Preparation reserves proofs and computes swap fees; execution can leave a pending operation. Coco's default melt watcher and settlement processor reconcile it; explicit refresh and terminal events are available. Finalized operations expose actual fee/change information. [Melting guide](https://cashubtc.github.io/coco/starting/melting.html), [melt operations](https://cashubtc.github.io/coco/pages/melt-operations.html).

NUT-30 quotes specify destination, payout amount, expiry, and fee options. Each option contains a maximum fee reserve and estimated confirmation target. Required proofs cover payout plus selected reserve plus input fees. The mint may charge the entire reserve. External on-chain settlement is asynchronous; an outpoint becomes available after broadcast, while `PAID` means confirmed. [NUT-30](https://github.com/cashubtc/nuts/blob/main/30.md).

Product policy clarified during the interview: one owner, one configured mint checked at startup, a local balance threshold that triggers a sweep, and sequential destination derivation without address-history queries. Fees do not influence whether the threshold is reached. The interview selected the lowest quoted fee option without a separate cap; the net sweep calculation still needs implementation verification.

### Sweep constraints

NUT-30's `amount` is the recipient amount, not a total spending budget. With available proofs `B`, recipient amount `A`, selected reserve `R`, and input fee `F`, a direct melt needs `A + R + F <= B`. Fee options remain fixed during a quote's lifetime; a client must select an advertised `fee_index`. The specification defines no preferred option or sorting rule. [NUT-30](https://github.com/cashubtc/nuts/blob/main/30.md).

Inference: ignoring fees for the trigger is compatible with the protocol; ignoring them when computing `amountSats` is not. A sweep needs an affordable recipient amount, including any Coco pre-swap cost. Refunded reserve can leave a small ecash remainder. The inspected API takes an explicit recipient amount; an automatic maximum-affordable-amount helper was not verified. The selected policy prefers the cheapest quoted fee over faster estimated confirmation.

### Recovery and destination index

For an external NUT-30 payout, `UNPAID` means unbroadcast, `PENDING` covers processing through confirmation wait, and `PAID` means confirmed. `outpoint` is `txid:vout` once broadcast; a pending response need not contain one. [NUT-30](https://github.com/cashubtc/nuts/blob/main/30.md).

Coco provides `ops.melt.getByQuote({ mintUrl, quoteId })`, `listByQuote(...)`, and `refresh(operationId)`. Refreshing the operation advances local proof/change settlement; refreshing only the quote does not. Startup recovery reconciles executing/pending operations, but leaves prepared operations for an application decision. Pending rollback requires confirmation that the quote is `UNPAID`; uncertain network outcomes are not proof of failure. Coco also documents immediate intramint settlement, sometimes without an outpoint; that is distinct from the intended external-wallet payout. [Melt operations](https://cashubtc.github.io/coco/pages/melt-operations.html).

Earlier optional recovery design inference: an active payout record could retain destination address/index, mint/quote identity, selected fee, and operation ID through unresolved outcomes. This was **not selected for the initial scope**: the interview subsequently settled optimistic index advancement at attempt start, with application-specific recovery deferred to Coco. Coco's documented recovery facts above still apply; they do not establish recovery of application-owned index state.

### Bun and SQLite support

Official adapter documentation explicitly supports `@cashu/coco-sqlite-bun`, exporting `SqliteRepositories` around a `bun:sqlite` `Database`, supplied to `initializeCoco`. The separate Node adapter uses `better-sqlite3`. This supports Bun + TypeScript + SQLite as a stack recommendation without selecting an HTTP framework. [Storage adapters](https://cashubtc.github.io/coco/pages/storage-adapters.html). PR #9 now pins and verifies the local repository/seed integration and migration coexistence; behavior during process termination and payment recovery still requires verification.

### CLI and server stack options

For the accepted Bun/TypeScript/SQLite process, both HTTP approaches are documented:

- **`Bun.serve`** already handles static paths, parameterized paths, HTTP-method handlers, and a fallback through Web `Request`/`Response`. Native `routes` support requires Bun 1.2.3 or later. This is sufficient infrastructure for a small LNURL endpoint set without a routing dependency. [Bun HTTP server](https://bun.sh/docs/runtime/http/server).
- **Hono** officially supports Bun and exposes `app.fetch`, route handlers, grouping, and middleware. It is an optional routing layer if shared request processing or a larger route set becomes useful. [Hono on Bun](https://hono.dev/docs/getting-started/bun), [routing API](https://hono.dev/docs/api/routing).

For the CLI:

- **`node:util.parseArgs`** is demonstrated in Bun's own guide. It parses flags and positionals; command dispatch and help text remain application work. It is a reasonable minimal choice for a few simple commands. [Bun argument parsing](https://bun.sh/guides/process/argv), [Node API](https://nodejs.org/api/util.html#utilparseargsconfig).
- **Commander** provides nested subcommands, argument/option handling, generated help, and asynchronous action parsing. Its current release notes acknowledge Bun's ESM support, while its formal support statement targets Node LTS. It is a reasonable candidate when CLI configuration makes structured subcommands and consistent help valuable; exact Bun compatibility has not been tested here. [Commander README](https://github.com/tj/commander.js), [release notes](https://github.com/tj/commander.js/releases).

The interview subsequently selected `Bun.serve` and Commander. The alternatives above remain research context; configuration storage in SQLite and applying changes on restart were selected separately.

Coco's documented Bun wiring is a `Database` from `bun:sqlite`, then `new SqliteRepositories({ database })` from `@cashu/coco-sqlite-bun`, passed as `repo` to `initializeCoco({ repo, seedGetter })` from `@cashu/coco-core`. Its documentation explicitly places seed provisioning and persistence with the caller: the SQLite adapter does not remove the need for an application-managed seed. This is separate from the destination wallet's public extended key. [Storage adapter wiring](https://cashubtc.github.io/coco/pages/storage-adapters.html), [Coco seed requirements](https://cashubtc.github.io/coco/starting/start-here.html).

## Deployment checks and remaining uncertainty

- Inspect the chosen mint's `/v1/info`: NUT-04 must advertise enabled `bolt11` minting and NUT-05 enabled `onchain` melting for the required unit, with compatible amount limits. [NUT-06](https://github.com/cashubtc/nuts/blob/main/06.md).
- CDK Mintd documents pluggable Lightning and on-chain backends. This establishes implementation availability, not that an arbitrary public mint enables both or has suitable liquidity. [CDK Mintd README](https://github.com/cashubtc/cdk/blob/main/crates/cdk-mintd/README.md).
- Verify the payment APIs against the release set now pinned by PR #9. Retrieved official pages contained both old `prepare({ mintUrl, ... })` examples and newer quote-first signatures; the current stable operation reference and published package README agree on quote-first preparation. The setup implementation establishes local wallet integration, but does not exercise those payment calls. [Older minting guide snapshot](https://cashubtc.github.io/coco/starting/minting.html), [current mint operations](https://cashubtc.github.io/coco/pages/mint-operations.html), [published core package](https://www.npmjs.com/package/@cashu/coco-core).
- Exercise a selected mint and representative payer wallets before claiming interoperability: invoice amount handling, payment while this service is offline, recovery during issuance, fee-option selection, and restart during a pending on-chain payout remain untested here.
- **Invoice metadata compatibility remains open.** The current fetched LUD-06 specifies invoice-amount validation without a description-hash check; NUT-23 exposes optional `description`, but no standardized `description_hash` request field. This does not demonstrate that every deployed LNURL wallet accepts an arbitrary mint invoice, or that a selected mint backend can produce a metadata-bound invoice. Confirm the actual invoices and payer behavior in an integration spike; do not equate plain `description` support with description-hash support. [Current LUD-06](https://github.com/lnurl/luds/blob/luds/06.md), [NUT-23](https://github.com/cashubtc/nuts/blob/main/23.md).
- Destination derivation and durable index/payout state remain application responsibilities. The history-query approaches in [the earlier address research](bitcoin-address-history.md) are optional background research and **are not the selected product policy**: Sats on Ice will derive addresses sequentially without querying address history, with a dedicated receiving account advised.

## Username scope and runtime domain

The interview settled a table mapping username to destination xpub and next payout index, with the public domain determined at runtime, then narrowed v1 to a single configured username per server. One owner, one configured mint, one accumulated balance, and one destination wallet remain. The selected proxy contract preserves the public hostname in `Host`, from which the application builds HTTPS callbacks; Fly.io was subsequently selected as the deployment target. The multi-username isolation alternatives below are deferred research, not v1 requirements.

### Coco balance isolation

The inspected public balance API scopes queries by mint URLs, units, and `trustedOnly`; it exposes no username/account selector. Each Manager receives a repository bundle and a `seedGetter`. A supported built-in per-account namespace was **not established** from the inspected references. [Core API README](https://github.com/cashubtc/coco/blob/master/packages/core/README.md).

The Bun adapter takes a caller-supplied SQLite database. Custom adapters may implement the `Repositories` contract, which includes proof, counter, quote, operation, history, and other state. [Storage adapters](https://cashubtc.github.io/coco/pages/storage-adapters.html).

Design inference for a possible future multi-username version: distinct Managers with distinct persistent seeds and genuinely separate repository storage, such as separate SQLite files, provide a plausible way to keep username wallets independent. Multiple Managers pointing at the same proof/operation tables are not isolated merely by different seeds. Shared-table partitioning would need a verified adapter namespace spanning all wallet state; it was not demonstrated here. Alternatively, one shared Coco wallet would require application accounting if receipts must remain attributable to individual username destinations. No multi-Manager integration was tested, and v1's single username avoids this requirement.

### Public origin behind an HTTPS proxy

Bun exposes `request.url` and request headers. Its server tests explicitly verify that incoming `Host` controls `request.url` and appears among request headers. The server's configured `hostname` is the listen address, not a public-domain setting. [Bun server tests](https://github.com/oven-sh/bun/blob/main/test/js/bun/http/serve.test.ts), [serve options](https://bun.sh/reference/bun/Serve/Options).

No automatic `X-Forwarded-Host`/`X-Forwarded-Proto` rewriting or built-in trusted-proxy setting was established from the inspected Bun server/options references. Do not assume `request.url` already reflects external HTTPS when the proxy-to-Bun hop uses HTTP. [Bun server documentation](https://bun.sh/docs/runtime/http/server).

As a concrete proxy example, Caddy sets `X-Forwarded-Host` and `X-Forwarded-Proto`, ignores client-supplied forwarded values by default, and supports trusted upstream proxy ranges when another proxy sits in front. Its HTTP backend configuration normally preserves `Host`; HTTPS upstream handling can replace it. This is evidence for the required deployment contract, not a selection of Caddy. [Caddy forwarding behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers).

Design inference: derive the public origin only from a trusted proxy's sanitized host/protocol values, with direct backend access restricted or peer trust explicitly checked. The proxy should route only the owner's intended public hosts. Runtime inference avoids storing a domain but does not remove the need to define that trust boundary.

LUD-16 resolves `username@domain` through HTTPS for clearnet domains, and LNURL-pay returns a callback URL. Consequently the inferred public origin must yield a payer-reachable callback, rather than an internal container hostname or backend HTTP origin. LUD-16 also constrains usernames to lowercase letters, digits, hyphen, underscore, and dot, with plus optional for tags. [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md), [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md).

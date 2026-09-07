# Chains

Anchor is not an Ethereum wallet that also knows about other chains. Someone who only cares about
Solana tokens should be able to set it up as easily as someone doing EVM NFTs, and the configuration
should say so:

```json
{ "chains": ["solana"], "wallets": ["So1111..."], "tokens": ["..."] }
```

This document is about where that is genuinely free and where it is not. Most of the surprise is that
the data side costs almost nothing, and nearly all the real divergence is in *writing* — which Anchor's
data service does not do at all.

> **Provenance.** Everything marked *verified* was checked against `@opensea/api-types@0.9.1` (which is
> generated from OpenSea's OpenAPI spec), against `@opensea/sdk@12.1.0`'s source, or against a live API
> response. Everything marked *unverified* comes from vendor documentation we did not exercise. The
> distinction is kept deliberately, because guessing here is how a security document becomes fiction.

## On the data side, a chain is a string

*Verified.* `ChainIdentifier` in `@opensea/api-types` is a union of 29 slugs, and `solana` is one of
them, sitting between `bera_chain` and `shape` with nothing special about it. The SDK's `Chain` enum
has exactly the same 29 values — `service/src/chains.ts` proves that at compile time rather than
keeping a copy, so a chain added upstream is a typecheck failure here rather than a slug Anchor
silently refuses.

The endpoints do not change shape by chain. The same `/account/{address}/tokens` returns SPL balances
for a Solana address and ERC-20 balances for an EVM one. The same `/chain/{chain}/token/{address}`
describes a Solana mint and an ERC-20 contract. There is no Solana-specific client, no second base
URL, and no separate response type.

### Which endpoints take a list, and which take one chain

*Verified against the OpenAPI spec.* Two shapes exist, and Anchor treats them differently:

| Shape | Endpoints | What Anchor does |
|---|---|---|
| `chains` query array | `/account/{address}/portfolio`, `/account/{address}/tokens`, `/tokens/trending`, `/tokens/top` | Sends **every** configured chain |
| `chain` in the path | `/chain/{chain}/account/{address}/nfts`, `/chain/{chain}/token/{address}`, `.../price_history` | Uses the **first** configured chain |
| `chain` query scalar | `/events/accounts/{address}` | Uses the **first** configured chain |
| No chain at all | everything under `/collections/…`, `/listings/…`, `/offers/…` | Chain is implied by the collection |

So the order of `chains` in the config is meaningful: the first entry is the one a path-scoped read
uses. `/health` reports it as `primaryChain` so nobody has to work that out from the source.

Two of the list-shaped endpoints are a **gap in the SDK rather than in the API**: `GetTokensArgs`
(trending and top) and `PortfolioArgs` both omit `chains`, though the spec documents it and the
server accepts it. The SDK forwards its args object to the query builder verbatim, so Anchor widens
the object with a comment at each site. Worth fixing upstream.

## Addresses are the one place the data side really differs

*Verified.* An address is not a chain-free concept, and this is the failure that actually bites:

- **EVM** — `0x` followed by 40 hex characters.
- **Solana** — base58 that decodes to exactly 32 bytes, with no `0x` prefix. Length alone is not
  enough: base58 is not fixed-width, so a 32-byte key is 32–44 characters and a 44-character string
  can decode to 33 bytes. `service/src/chains.ts` decodes rather than pattern-matching.

Neither `@opensea/sdk` nor `@opensea/api-types` offers a validator for this. The SDK exports
`checksumAddress`, which is EVM-only and throws on anything else; the spec's `SolanaAddress` and
`EvmAddress` schemas carry no `pattern`. So Anchor validates at config load, against the configured
chains, and refuses a mismatch with a message naming the field and the expected shape. An EVM address
in a Solana-only config is a typo, and finding out at startup beats a 400 three widgets deep.

## Where chains genuinely diverge: writing

None of this is in `service/`, which is read-only by construction. It is here because the agent side
will meet it, and because "Solana is just a slug" stops being true the moment something signs.

### Seaport order construction is EVM-only

*Verified from the SDK's source.* `OpenSeaSDK` — the class that builds and signs orders — takes an
ethers `Signer` or `JsonRpcProvider`, wraps `@opensea/seaport-js`, and signs EIP-712 typed data.
Every part of that is EVM. The SDK says so outright rather than failing obscurely: both
`getListingPaymentToken` and `getOfferPaymentToken` throw
`Chain solana is not supported for OpenSea Seaport listings` before anything else happens
(`lib/utils/chain.js`; Hyperliquid is refused the same way). An NFT listing or offer flow written
against the SDK is an EVM flow, and there is no Seaport deployment for it to point at on Solana.

### The swap endpoint absorbs most of the difference

*Verified from the spec.* `SwapAssetInput.chain` is documented as "Chain slug (e.g. ethereum, base,
solana)", so swaps are cross-chain by design, and `POST /api/v2/swap/execute` does not hand back something you
have to know how to build. It returns `SwapExecuteResponse`: a quote plus an **ordered list of
executable transactions**, each carrying its own `chain`. For EVM that is `to`, `data` (hex calldata)
and `value`. For Solana the same entry carries an `svm` object — "everything needed to compile and
sign a Solana v0 transaction": a base58 `from`, ordered instructions with `program_id`, accounts and
payload, and the address lookup tables the compiled message must reference. The client supplies a
recent blockhash and signs.

That is the important asymmetry. **Order construction is chain-specific and lives in the SDK; swap
construction is chain-specific and lives on the server.** So the token half of Anchor generalises to
Solana far more cheaply than the NFT half does — which is convenient, because the token half is
where a Solana-first user actually lives.

This is also exactly why `/swap/quote` and `/swap/execute` stay behind the executor and are never
called by the read-only service (see [tokens.md](tokens.md)). They return executable transaction
data, which is the boundary the service exists to hold.

### Wallets

The `Executor` interface in `docs/autonomy.md` was written so the enforcement backend is swappable.
Chain architecture is a second axis of the same idea, and it held: the executor now speaks both
architectures behind one interface, with a chain-scoped address type, one `PolicyAuthority`, and a
signer per architecture. Nothing about the policy model needed a second version.

What did *not* hold is the assumption that a vendor's policy engine is the same product on both
chains. **Privy supports Solana; Privy does not enforce the same policy on Solana.** The differences
are named in [autonomy.md](autonomy.md) and in `executor/README.md`, and the short version is:

| | EVM | Solana |
|---|---|---|
| Refuse a specific token instruction by name | `ethereum_calldata` + `function_name` | **not possible** — the token decoder covers six instructions and `Approve`/`SetAuthority` are not among them |
| Refuse a specific *System Program* instruction by name | n/a | possible — `solana_system_program_instruction` does carry `instructionName` |
| Cumulative spend cap | 72-hour window, two methods | **none at all** — no Solana method is supported by aggregations |
| Bound an address a v0 transaction loads from a lookup table | n/a | evaluation *fails* and the transaction is rejected |
| Bound the fee | the gas price is denominated in the asset the value cap counts | **no condition source exists** — `SetComputeUnitPrice` can commit the whole native balance and no rule can see it |

*Verified* against Privy's policy and API documentation; the table was re-read on **2026-09-07** and
two rows changed as a result. `solana_system_program_instruction` does support `instructionName` —
an earlier draft said that was unestablished — so the System Program hole, unlike the token program
one, is closable remotely. And the fee row is new, and is the worst of the set: the other rows are
controls weaker than their EVM counterparts, that one is a control with no remote expression at all.

The token row is the one that changes a design: on Solana the only way to keep a delegation out is an
ALLOW rule that positively lists the instructions you do send, so Privy's default-deny refuses the
rest — an omitted condition removes the control with no error anywhere, which is why Anchor's startup
audit treats its absence as a refusal to start. The fee row changes a different thing: it is stated
on every startup rather than refused, because no policy edit would fix it, and the ceiling in
`executor/src/solana.ts` is the only enforcement there is.

*Verified.* `ProjectOpenSea/wallet-adapters` has adapters for Privy, Turnkey, Fireblocks, Bankr and
local keys, and bridges for ethers and viem — all EVM. There is no Solana adapter today. That is a
gap worth closing upstream, since it is the package Anchor would otherwise use.

## `setApprovalForAll` has no Solana analogue — which is not the same as being safe

`setApprovalForAll` is human-only in Anchor, forever, because unlimited token approvals are how EVM
wallets actually get drained (`AGENTS.md`, invariant 3). Solana has no such call. It has its own
hazards, and they deserve naming rather than an assumption that a different model means a safer one.

*The following describes Solana's programming model, from its public documentation. It is not
OpenSea-specific and we have not exercised any of it in Anchor.*

- **SPL token delegate authority.** A token account can name a *delegate* with an approved amount
  (the `Approve` instruction). It is the closest thing to an ERC-20 allowance, it persists until
  revoked, and a delegate approved for `u64::MAX` is the direct analogue of unlimited approval. This
  belongs in the same human-only action class.
- **`SetAuthority`.** A token account's owner or close authority can be handed to another address
  outright. That is strictly worse than an allowance: it is not a spending limit, it is the account.
- **Upgradeable programs.** A Solana program deployed with an upgrade authority can have its code
  replaced by whoever holds that authority. A program audited today can be a different program
  tomorrow without the address changing. The EVM equivalent — a proxy behind an admin key — exists
  too, but on Solana it is the default deployment mode rather than an opt-in pattern. An allowlist
  keyed on a program address is therefore a weaker guarantee than an allowlist keyed on an immutable
  EVM contract, and the policy engine should treat "is this program still immutable" as a question.
- **Account closing and rent.** Closing a token account reclaims its rent to a chosen destination.
  It moves value, and it does not look like a transfer.

None of these change the shape of Anchor's answer, which is that authority is bounded somewhere the
agent cannot reach. They change what has to be on the human-only list, and the list is not the same
list.

### What the executor concluded

*Implemented.* `HUMAN_ONLY_ACTION_KINDS` in `executor/src/types.ts` now has three members:
`set-approval-for-all`, `approve-delegate` (SPL `Approve`/`ApproveChecked`/`Revoke`) and
`set-authority` (SPL `SetAuthority`, and a program's upgrade authority). `DelegableActionKind` is
derived by excluding them, so no policy can allowlist one — the compiler refuses, and a run-time
check reads the same constant for limits that arrived as JSON.

Two of the hazards above are deliberately *not* on the list, and the reasoning matters as much as the
list does:

- **Closing an account moves value**, so it fails the "moves nothing" test that defines the class. It
  is a transfer wearing a different hat, and it belongs under the withdrawal-destination allowlist.
  `executor/src/solana.ts` permits it and flags it, because a wrapped-SOL close sends the entire
  lamport balance to a destination named by an operand — which on a v0 transaction may be unreadable.
- **Arbitrary program invocation is not an action kind**, it is the absence of one. The type-level
  answer is that `ActionRequest` carries intent — a mint, an amount, a destination — and has no member
  that can hold instructions or bytes. An agent cannot ask for "sign these bytes" because the request
  type cannot express it. At the signer, a program allowlist is default-deny on top of that.

**Upgradeable programs remain unsolved**, and honestly so: an allowlisted program id says which code
runs, not what it does, and "is this program still immutable" is a chain read Anchor does not make.
The guard says as much in its `unverified` output rather than implying an allowlist settles it.

## Configuration

```json
{
  "chains": ["ethereum", "solana"],
  "wallets": ["0x…", "So1111…"],
  "collections": ["your-collection-slug"],
  "tokens": ["0x…"]
}
```

A single `"chain": "base"` string is still accepted and read as a one-element `chains`, so existing
configs keep working; the validation error says so when a value is wrong. Setting both is refused
rather than silently resolved. `wallets` follows the same pattern — a bare `"wallet": "0x…"` is read
as a one-element list — and every entry is checked against the configured chains, so a mixed-chain
config can watch an EVM address and a Solana one at once. An unknown slug fails at config load with the value quoted, a
suggestion, and the full list of valid chains.

## See also

- [tokens.md](tokens.md) — why fungible tokens are a different product, not NFTs with a quantity.
- [autonomy.md](autonomy.md) — where policy lives, and why it lives outside the agent.
- [security.md](security.md) — the read-only property and the credential model.

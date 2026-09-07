# NFTs and tokens

OpenSea is both marketplaces now. Anchor was designed around only one of them, and this documents the
correction.

The original thesis — *your art becomes the theme, your watchlist lives in the bar* — is an **NFT**
thesis. It is a good one, and it stays. But a large and fast-growing part of the audience trades
fungible tokens, and an OpenSea-native desktop that only understands JPEGs is half a product. Worse,
an agent told to "watch my OpenSea activity" would silently see half the picture.

## They are not the same product with different nouns

It is tempting to treat a token as an NFT with a quantity field. That framing breaks in five places,
and each one changes what we build.

**Ownership is a balance, not a set.** An NFT portfolio is a list of unique things you can show. A
token portfolio is positions with sizes and cost basis. "Display my collection" has no token analogue;
"what is my exposure" has no NFT analogue.

**Buying is swapping.** An NFT purchase is a fixed price for a specific item. A token purchase is a
swap through a route, with slippage, price impact and a quote that expires. There is no NFT equivalent
of "you paid what you agreed but received far less than you expected."

**Time scales differ by orders of magnitude.** A collection floor moving 5% over a day is news. A
memecoin moving 5% in a minute is Tuesday. The same notification system with the same thresholds is
either useless for one or unbearable for the other — thresholds must be relative to an asset's own
volatility, not absolute.

**Tokens have a safety question NFTs do not.** An NFT can be overpriced or unwanted; it cannot be
*unsellable by design*. Honeypots, transfer taxes, disappearing liquidity and freshly-minted contracts
are a whole risk class with no counterpart in a collection, and any agent permitted to swap must check
for them before it trades, not after.

**The desktop surface is different.** NFTs are visual and belong on the wallpaper, in a gallery, as a
palette. Tokens are numeric and belong in the bar as a compact number that changes. Both can be
ambient; they cannot be ambient the same way.

## What this changes

### The data service

The read-only service currently speaks only the NFT half of the API. The token half exists and is
substantial:

| Purpose | Endpoint |
|---|---|
| Net worth and P&L | `/api/v2/account/{address}/portfolio` |
| Balances for an account | `/api/v2/account/{address}/tokens` |
| Token metadata | `/api/v2/chain/{chain}/token/{address}` · `POST /api/v2/tokens/batch` |
| Price history and candles | `/api/v2/chain/{chain}/token/{address}/price_history` · `.../ohlcv` |
| Discovery | `/api/v2/tokens/trending` · `/api/v2/tokens/top` |
| Account swaps and transfers | `/api/v2/account/{address}/token-activity` |
| Per-token trade activity | `/api/v2/chain/{chain}/token/{address}/activity` · `.../activity/stats` |
| Holders and liquidity | `.../holders` · `.../liquidity-pools` |
| Swap quote | `/api/v2/swap/quote` |
| Swap execution | `POST /api/v2/swap/execute` |

> Every path in this table was wrong when it was written by hand — `token_balances_by_account`,
> `token_price_history`, `swap_quote` and the rest are not endpoints. They are now taken from
> `@opensea/api-types`, which is generated from OpenSea's OpenAPI spec, and the service calls them
> through `@opensea/sdk` rather than building URLs itself. That is the whole argument for using
> OpenSea's own packages: a hand-written copy of someone else's API rots, quietly, and the first
> symptom is a 404 in a widget.

`/swap/quote` and `/swap/execute` stay behind the executor and are never called by the read-only
service — they return executable transaction data, which is the boundary the service exists to hold.
`/swap/execute` returns transactions for EVM *and* Solana in the same response shape; see
[chains.md](chains.md).

### The ambient surface

One portfolio number, both asset classes. The gallery and palette extraction remain NFT-only, because
a token has nothing to show. What tokens add is a compact position readout and price movement that
earns attention on its own terms.

The failure mode to avoid is turning a calm desktop into a trading terminal. Token data is *more*
seductive here than NFT data precisely because it updates constantly. Default to quiet.

### Spend controls — the important part

Token trading breaks the existing policy model in ways worth stating plainly, because a cap that does
not survive contact with a swap is not a cap.

**Slippage is a spend control.** A limit of "$500 per transaction" means nothing if the swap executes
at 90% price impact: the agent spent $500 and received $50, and every dollar cap was respected.
`maxSlippageBps` and a minimum-liquidity floor belong in the policy alongside the dollar limits, and
they must be enforced in the same place — outside the agent.

**Cap exposure per asset, not per transaction.** For NFTs, a per-item cap works because each purchase
is a distinct thing. For tokens, ten separate $50 buys of the same coin is a $500 position. The limit
that matters is total exposure to an asset, which requires the policy engine to hold state across
transactions rather than judging each one alone.

**A quote is not a price.** Quotes expire. A policy decision made against a stale quote is a decision
made against a number that no longer exists, so the executor must bind the approval to the quote it
approved and refuse to submit if that quote has moved beyond tolerance.

**Token allowlists need a denylist too.** An NFT contract allowlist is a short list of marketplaces.
Tokens are permissionless and infinite: any agent trading them must refuse newly-deployed contracts,
low-liquidity pairs, and anything failing a sellability check — a default-deny posture that the NFT
side never needed.

## For agents

An agent working on this project should treat **OpenSea as both marketplaces**. "Check my OpenSea
activity" means NFTs *and* tokens. A watchlist can hold both. A portfolio number is both.

OpenSea publishes an agent skill covering the token side, including swaps
([ProjectOpenSea/opensea-skill](https://github.com/ProjectOpenSea/opensea-skill)) — worth reading
before building anything that trades, rather than reinventing the flow.

The safety rules do not relax for tokens. They tighten: everything in
[autonomy.md](autonomy.md) applies, plus slippage, liquidity, and sellability.

Tokens are also where chains stop being an Ethereum story. Solana is an ordinary chain slug on the
data side, the swap endpoint returns Solana instructions in the same shape as EVM calldata, and
`setApprovalForAll` has no Solana analogue but SPL delegate authority does the same damage. See
[chains.md](chains.md).

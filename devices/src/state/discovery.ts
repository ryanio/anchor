/**
 * Trending tokens and NFT collections — what anyone can look up, not what Ryan owns.
 *
 * `state/anchor.ts` is the portfolio: it answers "what do I hold." This module answers "what is
 * moving," for the Cardputer's browse mode and the ESP32's ambient rotation (see
 * `docs/plans` — the trending-tokens-and-NFTs plan approved with Ryan). Every field read here is
 * checked against a real response from the local service before being trusted, the same way
 * `state/anchor.ts` holds every portfolio field to that standard — and, following that module's own
 * shape, every `readX` below is a pure function a test can call with a fixture, never with a real
 * network call.
 */

import { get, isEnvelope } from "./service.ts";

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Money fields (`usdPrice`, `usdValue`, `amountUsd`) arrive as strings here, measured against the
 * live service on 2026-09-13 — `"usdPrice": "0.24363121651577396"` — the same convention
 * `state/anchor.ts`'s `PortfolioStats` already holds every dollar figure to, and for the same
 * reason: parsing to re-format is how precision goes missing, so it is parsed *for display only*,
 * here, at the boundary where a number is actually needed.
 */
function usd(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function list(data: unknown, key: string): readonly unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

// ── tokens ───────────────────────────────────────────────────────────────────────────────────

/** One row of a trending/top list — enough to show and enough to ask for detail on. */
export interface TrendingToken {
  readonly address: string;
  readonly chain: string;
  readonly name: string;
  readonly symbol: string;
  readonly imageUrl: string;
  readonly usdPrice: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24h: number | null;
  readonly priceChange24h: number | null;
  readonly openseaUrl: string;
}

/**
 * `/tokens/trending` and `/tokens/top`'s `data`, measured against the live service on 2026-09-13: a
 * `tokens` array of `{ address, chain, name, symbol, imageUrl, usdPrice, decimals, openseaUrl,
 * marketCapUsd, volume24h, priceChange24h, holdersCount, isVerified, createdAt, genesisDate }`. The
 * top result was a Solana token while this service's primary chain is Ethereum — `chain` is read
 * per row rather than assumed, and it is what `tokenDetail` needs to ask the right chain for a
 * token's holders and activity.
 */
export function readTrendingTokens(data: unknown): readonly TrendingToken[] {
  return list(data, "tokens").flatMap((entry): TrendingToken[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const address = str(raw.address);
    const chain = str(raw.chain);
    if (address === null || chain === null) return [];
    return [
      {
        address,
        chain,
        name: str(raw.name) ?? "",
        symbol: str(raw.symbol) ?? "",
        imageUrl: str(raw.imageUrl) ?? "",
        usdPrice: usd(raw.usdPrice),
        marketCapUsd: num(raw.marketCapUsd),
        volume24h: num(raw.volume24h),
        priceChange24h: num(raw.priceChange24h),
        openseaUrl: str(raw.openseaUrl) ?? "",
      },
    ];
  });
}

export async function trendingTokens(
  kind: "trending" | "top" = "trending",
  limit = 20,
  timeoutMs = 8000,
): Promise<readonly TrendingToken[]> {
  const result = await get(`/tokens/${kind}?limit=${limit}`, timeoutMs);
  if (result === null || result.status !== 200 || !isEnvelope(result.body)) return [];
  return readTrendingTokens(result.body.data);
}

/** One ranked holder of a token. */
export interface TokenHolder {
  readonly ownerAddress: string;
  readonly ownerDisplayName: string | null;
  readonly percentageHeld: number | null;
  readonly usdValue: number | null;
}

export interface TokenHolders {
  readonly holders: readonly TokenHolder[];
  readonly totalCount: number | null;
  /** 0-100. Higher means more concentrated in fewer wallets — the API's own judgement, not derived. */
  readonly healthScore: number | null;
  readonly healthLabel: string | null;
}

const EMPTY_TOKEN_HOLDERS: TokenHolders = {
  holders: [],
  totalCount: null,
  healthScore: null,
  healthLabel: null,
};

/**
 * `/tokens/:address/holders`'s `data`, measured 2026-09-13: `{ holders: [{ quantity,
 * percentageHeld, usdValue, ownerAddress, ownerDisplayName }], totalCount, distribution: {
 * totalHolders, topOnePercentConcentration, healthScore, healthLabel }, next }`.
 */
export function readTokenHolders(data: unknown): TokenHolders {
  if (typeof data !== "object" || data === null) return EMPTY_TOKEN_HOLDERS;
  const raw = data as Record<string, unknown>;
  const distribution =
    typeof raw.distribution === "object" && raw.distribution !== null
      ? (raw.distribution as Record<string, unknown>)
      : {};
  return {
    holders: list(raw, "holders").flatMap((entry): TokenHolder[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const h = entry as Record<string, unknown>;
      const ownerAddress = str(h.ownerAddress);
      if (ownerAddress === null) return [];
      return [
        {
          ownerAddress,
          ownerDisplayName: str(h.ownerDisplayName),
          percentageHeld: num(h.percentageHeld),
          usdValue: usd(h.usdValue),
        },
      ];
    }),
    totalCount: num(raw.totalCount),
    healthScore: num(distribution.healthScore),
    healthLabel: str(distribution.healthLabel),
  };
}

export async function tokenHolders(
  address: string,
  chain: string,
  limit = 20,
  timeoutMs = 8000,
): Promise<TokenHolders> {
  const result = await get(
    `/tokens/${encodeURIComponent(address)}/holders?chain=${encodeURIComponent(chain)}&limit=${limit}`,
    timeoutMs,
  );
  if (result === null || result.status !== 200 || !isEnvelope(result.body)) return EMPTY_TOKEN_HOLDERS;
  return readTokenHolders(result.body.data);
}

/** One swap in a token's buy/sell feed — a transfer between two sides, at least one of which is it. */
export interface TokenActivityEvent {
  readonly timestamp: number | null;
  readonly senderAddress: string;
  readonly fromSymbolOrAddress: string;
  readonly toSymbolOrAddress: string;
  readonly amountUsd: number | null;
}

function tokenSide(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const t = value as Record<string, unknown>;
  return str(t.symbol) ?? str(t.address) ?? "";
}

/**
 * `/tokens/:address/activity`'s `data`, measured 2026-09-13: `{ swapEvents: [{ id, timestamp,
 * senderAddress, fromToken: { address, chain, amountToken, amountUsd, amountNative }, toToken:
 * {...}, transactionHash, swapProtocol, chain }] }`. Neither side carries a symbol in the sample
 * measured — `fromSymbolOrAddress`/`toSymbolOrAddress` fall back to the address, which a renderer
 * can at least fit-ellipsise rather than show nothing.
 */
export function readTokenActivity(data: unknown): readonly TokenActivityEvent[] {
  return list(data, "swapEvents").flatMap((entry): TokenActivityEvent[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const senderAddress = str(e.senderAddress);
    if (senderAddress === null) return [];
    const fromToken =
      typeof e.fromToken === "object" && e.fromToken !== null
        ? (e.fromToken as Record<string, unknown>)
        : null;
    return [
      {
        timestamp: num(e.timestamp),
        senderAddress,
        fromSymbolOrAddress: tokenSide(e.fromToken),
        toSymbolOrAddress: tokenSide(e.toToken),
        amountUsd: fromToken === null ? null : usd(fromToken.amountUsd),
      },
    ];
  });
}

export async function tokenActivity(
  address: string,
  chain: string,
  limit = 20,
  timeoutMs = 8000,
): Promise<readonly TokenActivityEvent[]> {
  const result = await get(
    `/tokens/${encodeURIComponent(address)}/activity?chain=${encodeURIComponent(chain)}&limit=${limit}`,
    timeoutMs,
  );
  if (result === null || result.status !== 200 || !isEnvelope(result.body)) return [];
  return readTokenActivity(result.body.data);
}

/**
 * `{ holders, activity }` for one token, fetched the way `state/anchor.ts`'s `portfolio()` does —
 * in parallel, with `onPartial` firing as each piece lands rather than once at the end.
 */
export async function tokenDetail(
  token: Pick<TrendingToken, "address" | "chain">,
  onPartial?: (partial: { holders?: TokenHolders; activity?: readonly TokenActivityEvent[] }) => void,
): Promise<{ holders: TokenHolders; activity: readonly TokenActivityEvent[] }> {
  const holdersReady = tokenHolders(token.address, token.chain).then((holders) => {
    onPartial?.({ holders });
    return holders;
  });
  const activityReady = tokenActivity(token.address, token.chain).then((activity) => {
    onPartial?.({ activity });
    return activity;
  });
  const [holders, activity] = await Promise.all([holdersReady, activityReady]);
  return { holders, activity };
}

// ── collections ──────────────────────────────────────────────────────────────────────────────

/** One row of a trending/top collections list. */
export interface TrendingCollection {
  readonly slug: string;
  readonly name: string;
  readonly imageUrl: string;
  readonly openseaUrl: string;
}

/**
 * `/collections/trending` and `/collections/top`'s `data`, measured 2026-09-13: a `collections`
 * array of `{ collection, name, description, imageUrl, bannerImageUrl, owner, safelistStatus,
 * category, openseaUrl, ... }`. `collection` is the slug — named that in the response, unlike every
 * other collection route in `state/anchor.ts` which already calls it `slug`.
 */
export function readTrendingCollections(data: unknown): readonly TrendingCollection[] {
  return list(data, "collections").flatMap((entry): TrendingCollection[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const slug = str(raw.collection);
    if (slug === null) return [];
    return [
      {
        slug,
        name: str(raw.name) ?? "",
        imageUrl: str(raw.imageUrl) ?? "",
        openseaUrl: str(raw.openseaUrl) ?? "",
      },
    ];
  });
}

export async function trendingCollections(
  kind: "trending" | "top" = "trending",
  limit = 20,
  timeoutMs = 8000,
): Promise<readonly TrendingCollection[]> {
  const result = await get(`/collections/${kind}?limit=${limit}`, timeoutMs);
  if (result === null || result.status !== 200 || !isEnvelope(result.body)) return [];
  return readTrendingCollections(result.body.data);
}

/** One ranked holder of a collection. */
export interface CollectionHolder {
  readonly address: string;
  readonly quantity: number | null;
  readonly percentage: number | null;
}

/**
 * `/collections/:slug/holders`'s `data`, measured 2026-09-13: `{ holders: [{ address, quantity,
 * percentage }], next }`. Unlike a token holder's `usdValue`, `quantity`/`percentage` here are
 * plain numbers, not strings — an NFT count has no precision to lose the way a dollar figure does.
 */
export function readCollectionHolders(data: unknown): readonly CollectionHolder[] {
  return list(data, "holders").flatMap((entry): CollectionHolder[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const address = str(raw.address);
    if (address === null) return [];
    return [{ address, quantity: num(raw.quantity), percentage: num(raw.percentage) }];
  });
}

export async function collectionHolders(
  slug: string,
  limit = 20,
  timeoutMs = 8000,
): Promise<readonly CollectionHolder[]> {
  const result = await get(`/collections/${encodeURIComponent(slug)}/holders?limit=${limit}`, timeoutMs);
  if (result === null || result.status !== 200 || !isEnvelope(result.body)) return [];
  return readCollectionHolders(result.body.data);
}

/**
 * `{ holders }` for one collection — mirrors `tokenDetail`'s shape and its `onPartial` behaviour.
 * `listings`/`offers` are deliberately not parsed here: those routes return the SDK's raw
 * listing/offer shape, and the same discipline that governs everything else in this file says to
 * parse a shape once an actual consumer needs specific fields from it, not speculatively.
 */
export async function collectionDetail(
  slug: string,
  onPartial?: (partial: { holders?: readonly CollectionHolder[] }) => void,
): Promise<{ holders: readonly CollectionHolder[] }> {
  const holders = await collectionHolders(slug);
  onPartial?.({ holders });
  return { holders };
}

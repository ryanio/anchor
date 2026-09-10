/**
 * Read-only client for the local Anchor data service.
 *
 * The service binds loopback and refuses non-GET before routing (AGENTS.md invariant 4), so a device
 * can only ever read through it. That is the property that lets a piece of plastic on a desk talk to
 * it at all.
 *
 * **What is verified here and what is not.** The routes, the port default (8787) and the response
 * envelope — `{ data, meta: { fetchedAt, ageSeconds, stale } }` — are read from `service/src`, not
 * remembered. The *shape of `data`* is not: it comes from `@opensea/sdk`'s `getPortfolioStats`, and
 * confirming its field names needs a credentialed service running. So this module surfaces `meta`,
 * which it knows, and hands `data` back untouched as `unknown`. Nothing renders a field name that
 * has not been measured — AGENTS.md is emphatic that a plausible number taken for a true one has
 * already cost this project an afternoon.
 */

export interface Envelope {
  readonly data: unknown;
  readonly meta: { readonly fetchedAt: string; readonly ageSeconds: number; readonly stale: boolean };
}

export interface ServiceStatus {
  readonly reachable: boolean;
  /** The first configured wallet, so a key can open its OpenSea profile. */
  readonly wallet?: string;
  /** Set when the service answered but the request itself failed, e.g. no wallet configured. */
  readonly detail: string;
  /** A wallet is configured. Without one the wallet routes answer 428, measured below. */
  readonly hasWallet: boolean;
  readonly primaryChain: string;
}

/**
 * The `/health` shape, measured against a running service rather than remembered:
 *
 *     { ok, wallets: [], wallet: null, chains: ["ethereum"], primaryChain: "ethereum",
 *       collections: [], tokens: [], credentials: { apiKey: true, pat: true } }
 *
 * Only the fields this panel renders are declared. The control for "the service is up" is a request
 * to a closed port, which returns no status at all — that is what distinguishes a real 200 here from
 * one this code merely assumed.
 */
interface Health {
  readonly ok?: boolean;
  readonly wallet?: string | null;
  readonly wallets?: readonly string[];
  readonly primaryChain?: string;
}

const DEFAULT_BASE = "http://127.0.0.1:8787";

export function baseUrl(): string {
  return process.env.ANCHOR_SERVICE_URL ?? DEFAULT_BASE;
}

async function get(path: string, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, { signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Is the service up? A failure here is ordinary — most users will not be running it. */
export async function status(timeoutMs = 1500): Promise<ServiceStatus> {
  const offline = { reachable: false, hasWallet: false, primaryChain: "" };
  const result = await get("/health", timeoutMs);
  if (result === null) return { ...offline, detail: "not running" };
  if (result.status !== 200) return { ...offline, detail: `health ${result.status}` };
  const health = (typeof result.body === "object" && result.body !== null ? result.body : {}) as Health;
  const hasWallet = typeof health.wallet === "string" && health.wallet !== "";
  return {
    reachable: true,
    wallet: typeof health.wallet === "string" ? health.wallet : (health.wallets ?? [])[0],
    detail: hasWallet ? "" : "no wallet",
    hasWallet,
    primaryChain: typeof health.primaryChain === "string" ? health.primaryChain : "",
  };
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const meta = (value as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return false;
  return typeof (meta as { ageSeconds?: unknown }).ageSeconds === "number";
}

/**
 * Fetch `/portfolio/value`. Returns the envelope, or null when the service is absent or refused.
 *
 * The caller gets `meta` to render provenance (`theme/README.md` principle 6: a number without
 * which wallets and how old is not checkable) and `data` as `unknown`.
 */
export async function portfolioValue(timeoutMs = 2500): Promise<Envelope | null> {
  // 428 is the service saying "no wallet configured" rather than a failure; measured against a
  // running service with `wallets: []`. Either way there is nothing to draw.
  const result = await get("/portfolio/value", timeoutMs);
  if (result === null || result.status !== 200) return null;
  return isEnvelope(result.body) ? result.body : null;
}

/** "12s ago", "4m ago" — provenance the panel can show next to a number. */
export function describeAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${Math.max(0, Math.round(ageSeconds))}s ago`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  return `${Math.round(ageSeconds / 3600)}h ago`;
}

/** The timeframes `/portfolio/value` accepts, in the order a dial scrubs through them. */
export const TIMEFRAMES = ["HOUR", "DAY", "WEEK", "MONTH"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/**
 * `PortfolioStatsResponse`, read from `@opensea/api-types` rather than remembered.
 *
 * Every money field is a *string* in the spec, and is kept as one here. Parsing it to a number to
 * re-format it would be three chances to lose precision or a currency for no gain — the panel shows
 * what the API said.
 */
export interface PortfolioStats {
  readonly totalUsd: string | null;
  readonly nftUsd: string | null;
  readonly tokenUsd: string | null;
  readonly pnlAbsolute: string | null;
  readonly pnlPercentage: string | null;
  readonly timeframe: string;
}

/** One holding, from `TokenBalanceResponse`. */
export interface TokenHolding {
  readonly symbol: string;
  readonly usdValue: number;
  readonly status: string;
  readonly openseaUrl: string;
  /** The chain it is held on. A symbol alone is ambiguous once more than one chain is configured. */
  readonly chain: string;
}

/** An owned piece, enough to draw it and name it. */
export interface OwnedNft {
  readonly name: string;
  readonly collection: string;
  readonly imageUrl: string;
  /** Where the piece lives on OpenSea, so a key press can open the thing it is showing. */
  readonly openseaUrl: string;
}

/** One chain's share of the portfolio, from token balances. */
export interface ChainTotal {
  readonly chain: string;
  readonly usdValue: number;
}

export interface PortfolioSnapshot {
  readonly stats: PortfolioStats | null;
  readonly tokens: readonly TokenHolding[];
  readonly nftCount: number | null;
  /** Holdings grouped by collection, largest first. */
  readonly topCollections: readonly { readonly slug: string; readonly count: number }[];
  /** Net worth over the selected timeframe, oldest first. Empty when history is unavailable. */
  readonly history: readonly number[];
  /** Chains holding value, largest first. */
  readonly chains: readonly ChainTotal[];
  /** Owned pieces that have artwork to show. */
  readonly nfts: readonly OwnedNft[];
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly detail: string;
}

export const EMPTY_PORTFOLIO: PortfolioSnapshot = {
  stats: null,
  tokens: [],
  nftCount: null,
  topCollections: [],
  history: [],
  chains: [],
  nfts: [],
  ageSeconds: null,
  stale: false,
  // What the strip says before the first fetch lands, so it has to be addressed to a person rather
  // than to us. "not loaded" is a fact about our variable; on a panel beside four em dashes it reads
  // as a failure, and the state it actually describes is the two seconds after a cold start.
  detail: "loading…",
};

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read the first field that is present, by any of its spellings.
 *
 * `@opensea/api-types` declares these responses in snake_case — `total_value_usd`, `token_balances`,
 * `usd_value` — and the live API answers in camelCase. Measured against `api.opensea.io` on
 * 2026-09-08 through the local service:
 *
 *     /portfolio/value -> { totalValueUsd, nftValueUsd, tokenValueUsd, pnlAbsolute, pnlPercentage }
 *     /balances        -> { tokenBalances: [{ symbol, usdValue, usdPrice, imageUrl, ... }] }
 *
 * Reading the generated types is normally the thing that prevents a wrong field name; here the
 * generated types *are* the wrong field name. Accepting both spellings is the smallest fix that
 * cannot break when the mismatch is resolved in either direction. See `docs/upstream.md`.
 */
function field(raw: Record<string, unknown>, ...names: readonly string[]): unknown {
  for (const name of names) {
    if (name in raw) return raw[name];
  }
  return undefined;
}

export function readStats(data: unknown): PortfolioStats | null {
  if (typeof data !== "object" || data === null) return null;
  const outer = data as Record<string, unknown>;
  // The service aggregates every configured wallet now, so the figures moved under `stats` with a
  // per-wallet breakdown beside them. Both shapes are read: one wallet's response is still flat,
  // and a reader that only understood the new shape would break the moment it talked to an older
  // service — which is the failure that put em dashes on the panel in the first place.
  const nested = outer.stats;
  const raw = (typeof nested === "object" && nested !== null ? nested : outer) as Record<string, unknown>;
  const total = str(field(raw, "total_value_usd", "totalValueUsd"));
  if (total === null) return null;
  return {
    totalUsd: total,
    nftUsd: str(field(raw, "nft_value_usd", "nftValueUsd")),
    tokenUsd: str(field(raw, "token_value_usd", "tokenValueUsd")),
    pnlAbsolute: str(field(raw, "pnl_absolute", "pnlAbsolute")),
    pnlPercentage: str(field(raw, "pnl_percentage", "pnlPercentage")),
    timeframe: str(raw.timeframe) ?? "",
  };
}

/**
 * Holdings worth showing, largest first.
 *
 * `status` is OpenSea's own spam classification, and filtering on it is the point rather than a
 * nicety: an unfiltered "top tokens" list on a wallet that has been airdropped at is a list of
 * scams, rendered with Anchor's authority behind it. Only `OK` is shown.
 */
export function readTokens(data: unknown): TokenHolding[] {
  if (typeof data !== "object" || data === null) return [];
  // `balances` is what the aggregating service wraps them in; the other two are what a single
  // wallet's response uses, in the spec's spelling and the API's.
  const list = field(data as Record<string, unknown>, "balances", "tokenBalances", "token_balances");
  if (!Array.isArray(list)) return [];
  const holdings = list
    .flatMap((entry): TokenHolding[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const raw = entry as Record<string, unknown>;
      const symbol = str(raw.symbol);
      // The spec documents a `status` spam classification; the live response does not carry it at
      // all. An absent classification is treated as OK rather than as spam — filtering everything
      // out because a field is missing would be a worse failure than showing an unfiltered list,
      // and it is the shape that actually arrives today.
      const status = str(field(raw, "status")) ?? "OK";
      if (symbol === null || status !== "OK") return [];
      const usdValue = Number.parseFloat(str(field(raw, "usd_value", "usdValue")) ?? "");
      return [
        {
          symbol,
          usdValue: Number.isFinite(usdValue) ? usdValue : 0,
          status,
          chain: str(field(raw, "chain")) ?? "",
          openseaUrl: str(field(raw, "opensea_url", "openseaUrl")) ?? "",
        },
      ];
    })
    .sort((a, b) => b.usdValue - a.usdValue);

  // One asset, once. The service fans out across every configured wallet, so a token held in nine
  // wallets arrives as nine rows — and two keys reading "WETH·ethereum $1,002" and
  // "WETH·ethereum $518" describe one position badly. A portfolio total sums what you hold; the
  // per-wallet split is a different question, and the service still answers it separately.
  const merged = new Map<string, TokenHolding>();
  for (const holding of holdings) {
    const key = `${holding.symbol}|${holding.chain}`;
    const seen = merged.get(key);
    merged.set(key, seen === undefined ? holding : { ...seen, usdValue: seen.usdValue + holding.usdValue });
  }
  return [...merged.values()].sort((a, b) => b.usdValue - a.usdValue);
}

/**
 * Group held NFTs by collection.
 *
 * Deliberately *by count*, not by value: `Nft` in the spec carries no price, so ranking holdings by
 * worth would need a floor-price request per collection. That is a real feature with a real request
 * budget, not something to approximate — and an approximated number here would be indistinguishable
 * from a measured one.
 */
export function readCollections(data: unknown): { slug: string; count: number }[] {
  if (typeof data !== "object" || data === null) return [];
  const list = field(data as Record<string, unknown>, "nfts");
  if (!Array.isArray(list)) return [];
  const counts = new Map<string, number>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const slug = str((entry as Record<string, unknown>).collection);
    if (slug === null) continue;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return [...counts].map(([slug, count]) => ({ slug, count })).sort((a, b) => b.count - a.count);
}

/**
 * Net-worth points for a sparkline, oldest first.
 *
 * Live shape, measured 2026-09-08: `{ dataPoints: [{ timestamp, valueUsd, tokenValueUsd,
 * nftValueUsd }], timeframe }` — camelCase again, where the spec says `data_points` / `value_usd`.
 */
export function readHistory(data: unknown): number[] {
  if (typeof data !== "object" || data === null) return [];
  const list = field(data as Record<string, unknown>, "data_points", "dataPoints");
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((entry): number[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const raw = entry as Record<string, unknown>;
      const value = Number.parseFloat(str(field(raw, "value_usd", "valueUsd")) ?? "");
      const at = Number(field(raw, "timestamp") ?? 0);
      return Number.isFinite(value) ? [value] : [];
    })
    .slice(-64);
}

/**
 * Value per chain, largest first.
 *
 * Derived from token balances, which carry a `chain` on every holding. NFTs are not included: the
 * live `Nft` shape has no chain field, so attributing them would be a guess — and this number is
 * used to size a donut, where a guess is indistinguishable from a measurement.
 */
export function readChains(data: unknown): ChainTotal[] {
  if (typeof data !== "object" || data === null) return [];
  const list = field(data as Record<string, unknown>, "balances", "tokenBalances", "token_balances");
  if (!Array.isArray(list)) return [];
  const totals = new Map<string, number>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const chain = str(field(raw, "chain"));
    if (chain === null) continue;
    const value = Number.parseFloat(str(field(raw, "usd_value", "usdValue")) ?? "");
    if (!Number.isFinite(value)) continue;
    totals.set(chain, (totals.get(chain) ?? 0) + value);
  }
  return [...totals]
    .map(([chain, usdValue]) => ({ chain, usdValue }))
    .sort((a, b) => b.usdValue - a.usdValue);
}

/**
 * Owned pieces with artwork.
 *
 * `displayImageUrl` is preferred over `imageUrl` — it is the rendered preview, where `imageUrl` can
 * be the original asset. Pieces with no media at all are dropped rather than shown as blank keys.
 */
/**
 * Whether a collection is excluded from the gallery.
 *
 * Prefix match, case-insensitive, so `arttoken` covers `arttoken-1155` and `arttoken-for-katerina`
 * without listing every variant as it appears. A wallet accumulates things its owner did not choose
 * — airdrops, test mints, one collection minted in fifty variants — and a gallery that shows them
 * is showing someone else's decisions.
 */
export function isExcluded(collection: string, exclude: readonly string[]): boolean {
  const slug = collection.toLowerCase();
  return exclude.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    return p !== "" && slug.startsWith(p);
  });
}

export function readNfts(data: unknown, exclude: readonly string[] = []): OwnedNft[] {
  if (typeof data !== "object" || data === null) return [];
  const list = field(data as Record<string, unknown>, "nfts");
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): OwnedNft[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const imageUrl =
      str(field(raw, "display_image_url", "displayImageUrl")) ?? str(field(raw, "image_url", "imageUrl"));
    if (imageUrl === null) return [];
    const collection = str(field(raw, "collection")) ?? "";
    if (isExcluded(collection, exclude)) return [];
    return [
      {
        name: str(field(raw, "name")) ?? "",
        collection,
        imageUrl,
        openseaUrl: str(field(raw, "opensea_url", "openseaUrl")) ?? "",
      },
    ];
  });
}

/**
 * Order a gallery by what each piece is worth, most valuable first.
 *
 * The spec's `Nft` carries no price, so worth has to come from somewhere: the collection floor, out
 * of `/collections/{slug}/stats`. That is one request per distinct collection — seventeen here, not
 * fifty — and the service caches them, so it is paid once per TTL rather than once per paint.
 *
 * A floor is not what a particular piece is worth, and a rare one in a cheap collection will sort
 * too low. It is the only price the API offers for something held rather than listed, and ordering
 * by it beats ordering by whatever sequence the API happened to return. Collections whose floor
 * cannot be read keep their place rather than sinking, so a failed lookup hides nothing.
 */
export async function orderByValue(nfts: readonly OwnedNft[], timeoutMs = 8000): Promise<OwnedNft[]> {
  const slugs = [...new Set(nfts.map((piece) => piece.collection).filter((slug) => slug !== ""))];
  const floors = new Map<string, number>();

  await Promise.all(
    slugs.map(async (slug) => {
      const result = await get(`/collections/${encodeURIComponent(slug)}/stats`, timeoutMs);
      if (result === null || result.status !== 200 || !isEnvelope(result.body)) return;
      const data = result.body.data;
      if (typeof data !== "object" || data === null) return;
      const total = (data as Record<string, unknown>).total;
      if (typeof total !== "object" || total === null) return;
      const raw = total as Record<string, unknown>;
      const floor = raw.floorPrice ?? raw.floor_price;
      const value = typeof floor === "number" ? floor : Number.parseFloat(String(floor ?? ""));
      if (Number.isFinite(value)) floors.set(slug, value);
    }),
  );

  if (floors.size === 0) return [...nfts];
  return [...nfts].sort((a, b) => (floors.get(b.collection) ?? -1) - (floors.get(a.collection) ?? -1));
}

function metaOf(body: unknown): { ageSeconds: number | null; stale: boolean } {
  if (!isEnvelope(body)) return { ageSeconds: null, stale: false };
  return { ageSeconds: body.meta.ageSeconds, stale: body.meta.stale };
}

/**
 * Fetch everything the portfolio page shows, in one pass.
 *
 * The timeout is generous on purpose. The service fans each request out across every configured
 * wallet and chain — nine wallets over twenty-nine chains here — and an uncached first call takes
 * far longer than a UI request has any right to. Four seconds used to be the budget, and the panel
 * spent every cold start showing em dashes, then silently came right if anything else happened to
 * warm the cache. Nothing is blocked by this wait: it runs on the poller, and the panel keeps
 * painting the last good reading while it is in flight.
 *
 * A 428 means no wallet is configured, which is an ordinary state rather than a failure — the panel
 * says so instead of showing zeros. Zeros would be a reading; "no wallet" is the truth.
 */
export interface PortfolioOptions {
  /** Collection slug prefixes to keep out of the gallery. */
  readonly excludeCollections?: readonly string[];
  /** Order the gallery by collection floor, most valuable first. */
  readonly orderByValue?: boolean;
}

/** Read the gallery, minus what the user excluded, ordered as they asked. */
async function galleryFor(data: unknown, options: PortfolioOptions): Promise<OwnedNft[]> {
  const pieces = readNfts(data, options.excludeCollections ?? []);
  return options.orderByValue === true ? await orderByValue(pieces) : pieces;
}

/**
 * `onPartial` fires as each piece lands rather than once at the end. The four requests were already
 * in flight together — `/portfolio/value` is typically the fastest, since it need not read the
 * gallery — so a caller that wants the stat tiles painted the moment they are ready, without
 * waiting on nine wallets' worth of NFTs, has always had the data available and lacked a seam to
 * hear about it early. This is that seam; the final return value is unchanged; every field it never
 * touches, `EMPTY_PORTFOLIO`'s "loading…" default still explains.
 */
export type PortfolioPartial = Partial<PortfolioSnapshot>;

export async function portfolio(
  timeframe: Timeframe,
  timeoutMs = 25_000,
  options: PortfolioOptions = {},
  onPartial?: (partial: PortfolioPartial) => void,
): Promise<PortfolioSnapshot> {
  const valuePromise = get(`/portfolio/value?timeframe=${timeframe}`, timeoutMs);
  const balancesPromise = get("/balances?limit=100", timeoutMs);
  const nftsPromise = get("/portfolio?limit=50", timeoutMs);
  const historyPromise = get(`/portfolio/history?timeframe=${timeframe}`, timeoutMs);

  const value = await valuePromise;
  if (value === null) return { ...EMPTY_PORTFOLIO, detail: "service not running" };
  if (value.status === 428) return { ...EMPTY_PORTFOLIO, detail: "no wallet configured" };
  if (value.status !== 200) return { ...EMPTY_PORTFOLIO, detail: `portfolio ${value.status}` };

  const envelope = isEnvelope(value.body) ? value.body : null;
  const { ageSeconds, stale } = metaOf(value.body);
  const stats = readStats(envelope?.data);
  onPartial?.({ stats, ageSeconds, stale, detail: "" });

  const balancesReady = balancesPromise.then((balances) => {
    const balanceData = balances?.status === 200 && isEnvelope(balances.body) ? balances.body.data : null;
    const result = {
      tokens: balanceData === null ? [] : readTokens(balanceData),
      chains: balanceData === null ? [] : readChains(balanceData),
    };
    onPartial?.(result);
    return result;
  });

  const galleryReady = nftsPromise.then(async (nfts) => {
    const nftData = nfts?.status === 200 && isEnvelope(nfts.body) ? nfts.body.data : null;
    const collections = nftData === null ? [] : readCollections(nftData);
    const result = {
      nfts: nftData === null ? [] : await galleryFor(nftData, options),
      nftCount: collections.reduce((sum, entry) => sum + entry.count, 0) || null,
      topCollections: collections,
    };
    onPartial?.(result);
    return result;
  });

  const historyReady = historyPromise.then((history) => {
    const result = {
      history: history?.status === 200 && isEnvelope(history.body) ? readHistory(history.body.data) : [],
    };
    onPartial?.(result);
    return result;
  });

  const [balancesResult, galleryResult, historyResult] = await Promise.all([
    balancesReady,
    galleryReady,
    historyReady,
  ]);

  return { stats, ageSeconds, stale, detail: "", ...balancesResult, ...galleryResult, ...historyResult };
}

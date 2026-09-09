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
  /** The chain it is held on. A symbol alone is ambiguous once more than one chain is configured. */
  readonly chain: string;
}

/** An owned piece, enough to draw it and name it. */
export interface OwnedNft {
  readonly name: string;
  readonly collection: string;
  readonly imageUrl: string;
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
  detail: "not loaded",
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
  const raw = data as Record<string, unknown>;
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
  const list = field(data as Record<string, unknown>, "token_balances", "tokenBalances");
  if (!Array.isArray(list)) return [];
  return list
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
        },
      ];
    })
    .sort((a, b) => b.usdValue - a.usdValue);
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
  const list = field(data as Record<string, unknown>, "token_balances", "tokenBalances");
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
export function readNfts(data: unknown): OwnedNft[] {
  if (typeof data !== "object" || data === null) return [];
  const list = field(data as Record<string, unknown>, "nfts");
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): OwnedNft[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const imageUrl =
      str(field(raw, "display_image_url", "displayImageUrl")) ?? str(field(raw, "image_url", "imageUrl"));
    if (imageUrl === null) return [];
    return [
      {
        name: str(field(raw, "name")) ?? "",
        collection: str(field(raw, "collection")) ?? "",
        imageUrl,
      },
    ];
  });
}

function metaOf(body: unknown): { ageSeconds: number | null; stale: boolean } {
  if (!isEnvelope(body)) return { ageSeconds: null, stale: false };
  return { ageSeconds: body.meta.ageSeconds, stale: body.meta.stale };
}

/**
 * Fetch everything the portfolio page shows, in one pass.
 *
 * A 428 means no wallet is configured, which is an ordinary state rather than a failure — the panel
 * says so instead of showing zeros. Zeros would be a reading; "no wallet" is the truth.
 */
export async function portfolio(timeframe: Timeframe, timeoutMs = 4000): Promise<PortfolioSnapshot> {
  const [value, balances, nfts, history] = await Promise.all([
    get(`/portfolio/value?timeframe=${timeframe}`, timeoutMs),
    get("/balances?limit=100", timeoutMs),
    get("/portfolio?limit=50", timeoutMs),
    get(`/portfolio/history?timeframe=${timeframe}`, timeoutMs),
  ]);

  if (value === null) return { ...EMPTY_PORTFOLIO, detail: "service not running" };
  if (value.status === 428) return { ...EMPTY_PORTFOLIO, detail: "no wallet configured" };
  if (value.status !== 200) return { ...EMPTY_PORTFOLIO, detail: `portfolio ${value.status}` };

  const envelope = isEnvelope(value.body) ? value.body : null;
  const { ageSeconds, stale } = metaOf(value.body);
  const nftData = nfts?.status === 200 && isEnvelope(nfts.body) ? nfts.body.data : null;
  const collections = nftData === null ? [] : readCollections(nftData);

  const balanceData = balances?.status === 200 && isEnvelope(balances.body) ? balances.body.data : null;
  return {
    stats: readStats(envelope?.data),
    tokens: balanceData === null ? [] : readTokens(balanceData),
    history: history?.status === 200 && isEnvelope(history.body) ? readHistory(history.body.data) : [],
    chains: balanceData === null ? [] : readChains(balanceData),
    nfts: nftData === null ? [] : readNfts(nftData),
    nftCount: collections.reduce((sum, entry) => sum + entry.count, 0) || null,
    topCollections: collections,
    ageSeconds,
    stale,
    detail: "",
  };
}

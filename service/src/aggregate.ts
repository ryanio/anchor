/**
 * Reading several wallets as one portfolio.
 *
 * Every wallet-scoped route used `config.wallets[0]` and every caller presented the answer as the
 * whole picture. A three-wallet setup saw wallet one's total under a label reading "3 wallets" —
 * a plausible number that is not the number it claims to be, which is the one failure this project
 * has already lost an afternoon to.
 *
 * So the routes fan out and the results are combined here. Three rules the shapes below follow:
 *
 * 1. **Money is summed as decimal strings, never through a float.** `0.1 + 0.2` is the canonical
 *    reason, and portfolio totals are exactly where a hundredth of a cent becomes a support ticket.
 * 2. **A partial answer is labelled, never silently trimmed.** If one wallet of three fails, the
 *    total covers two and says so. Dropping it quietly would reproduce the bug being fixed here,
 *    one layer down.
 * 3. **The combined shape is the single-wallet shape plus fields.** `data.stats` stays where it was,
 *    so a client that never learns about multiple wallets keeps working and keeps being right.
 */

/** One wallet's result, or the reason there isn't one. */
export type WalletResult<T> =
  | { readonly wallet: string; readonly ok: true; readonly value: T }
  | { readonly wallet: string; readonly ok: false; readonly error: string };

export interface Fanned<T> {
  readonly results: readonly WalletResult<T>[];
  /** Wallets that answered. */
  readonly ok: readonly { wallet: string; value: T }[];
  /** Wallets that did not, in order. Empty is the happy path. */
  readonly incomplete: readonly string[];
}

/**
 * Run one read per wallet, keeping failures rather than throwing them.
 *
 * Sequential on purpose. The client already funnels every request through one rate limiter, so
 * firing N at once buys nothing and costs the limiter's queue depth — and a portfolio refresh with
 * six wallets should not be able to starve the health check behind it.
 */
export async function fanOut<T>(
  wallets: readonly string[],
  read: (wallet: string) => Promise<T>,
  /**
   * Errors that are about the request rather than about a wallet, and must not become a partial
   * answer.
   *
   * A rejected credential is the case that matters: with it swallowed, asking for six wallets and
   * getting six auth failures returns `200` with a total of nothing and a list of six "incomplete"
   * addresses — a broken setup rendered as an empty portfolio. The caller decides, because only the
   * caller knows which of its errors are per-wallet.
   */
  fatal: (err: unknown) => boolean = () => false,
): Promise<Fanned<T>> {
  const results: WalletResult<T>[] = [];
  for (const wallet of wallets) {
    try {
      results.push({ wallet, ok: true, value: await read(wallet) });
    } catch (err) {
      if (fatal(err)) throw err;
      // The message is already scrubbed to a status-derived string by the client; a remote body
      // never reaches here. Kept per wallet so "which one failed" survives to the response.
      results.push({ wallet, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    results,
    ok: results
      .filter((r): r is Extract<WalletResult<T>, { ok: true }> => r.ok)
      .map((r) => ({
        wallet: r.wallet,
        value: r.value,
      })),
    incomplete: results.filter((r) => !r.ok).map((r) => r.wallet),
  };
}

// --- Decimal arithmetic ---------------------------------------------------------------------

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Add decimal strings exactly, via BigInt at a common scale.
 *
 * Not `Number`: these are money. A total assembled from six wallets through binary floating point
 * lands a cent or two away from the sum of what each wallet's own page shows, and "the widget
 * disagrees with OpenSea" is indistinguishable from "the widget is broken".
 */
export function sumDecimals(values: readonly (string | null | undefined)[]): string | null {
  const usable = values.filter((v): v is string => typeof v === "string" && DECIMAL.test(v.trim()));
  if (usable.length === 0) return null;

  const scale = Math.max(...usable.map((v) => (v.split(".")[1] ?? "").length));
  let total = 0n;
  for (const value of usable) {
    const [whole, frac = ""] = value.trim().split(".");
    const negative = whole!.startsWith("-");
    const digits = `${whole!.replace("-", "")}${frac.padEnd(scale, "0")}`;
    total += (negative ? -1n : 1n) * BigInt(digits);
  }

  if (scale === 0) return total.toString();
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const out = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${out}` : out;
}

/** The first present value under any of these keys, as a decimal string. */
export function pickDecimal(source: unknown, keys: readonly string[]): string | null {
  if (source === null || typeof source !== "object") return null;
  for (const key of keys) {
    const raw = (source as Record<string, unknown>)[key];
    if (typeof raw === "string" && DECIMAL.test(raw.trim())) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

// --- Merging what the routes return ------------------------------------------------------------

/**
 * The field names OpenSea has used for these figures.
 *
 * The response has changed shape more than once and the SDK camelises what it returns, so both
 * spellings are tried. The same lists exist in the widget's model for the same reason; they are
 * short, and duplicating four arrays beats coupling a QML script to a TypeScript module.
 */
const TOTAL_KEYS = ["totalValueUsd", "total_value_usd", "netWorthUsd", "net_worth_usd", "value"];
const NFT_KEYS = ["nftValueUsd", "nft_value_usd"];
const TOKEN_KEYS = ["tokenValueUsd", "token_value_usd"];
const PNL_ABS_KEYS = ["pnlAbsolute", "pnl_absolute"];

/** Where a portfolio response keeps its figures, whichever shape it arrived in. */
function stats(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  return v.stats ?? v.portfolio ?? v;
}

export interface CombinedPortfolio {
  readonly stats: {
    readonly totalValueUsd: string | null;
    readonly nftValueUsd: string | null;
    readonly tokenValueUsd: string | null;
    readonly pnlAbsolute: string | null;
    readonly pnlPercentage: string | null;
  };
  /** Per wallet, in configured order — the drill-down, and the audit trail for the total. */
  readonly wallets: readonly {
    readonly address: string;
    readonly totalValueUsd: string | null;
    readonly nftValueUsd: string | null;
    readonly tokenValueUsd: string | null;
  }[];
  /** Wallets the total does not include. Empty on the happy path. */
  readonly incomplete: readonly string[];
}

/**
 * One portfolio from several.
 *
 * `stats` keeps the single-wallet shape so `readPortfolio` on the other side needs no change and a
 * client that never learns about `wallets` stays correct. Percentage change is deliberately absent:
 * a weighted average of six P&L percentages is a number nobody asked for and everybody would read
 * as "my portfolio moved this much", which it is not.
 */
/**
 * A portfolio's percentage move, from the absolute move and the value it ended at.
 *
 * `start = end - change`, so the percentage is `change / start`. Returns null rather than a
 * fabricated zero when either input is missing or the start would be zero — a portfolio that began
 * at nothing has no percentage, and inventing one would be a number nobody could check.
 */
export function percentageOf(change: string | null, end: string | null): string | null {
  if (change === null || end === null) return null;
  const moved = Number.parseFloat(change);
  const finished = Number.parseFloat(end);
  if (!Number.isFinite(moved) || !Number.isFinite(finished)) return null;
  const started = finished - moved;
  if (started === 0) return null;
  const pct = (moved / started) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}`;
}

export function combinePortfolio(fanned: Fanned<unknown>): CombinedPortfolio {
  const rows = fanned.ok.map(({ wallet, value }) => {
    const source = stats(value);
    return {
      address: wallet,
      totalValueUsd: pickDecimal(source, TOTAL_KEYS),
      nftValueUsd: pickDecimal(source, NFT_KEYS),
      tokenValueUsd: pickDecimal(source, TOKEN_KEYS),
      pnlAbsolute: pickDecimal(source, PNL_ABS_KEYS),
    };
  });

  const totalValueUsd = sumDecimals(rows.map((r) => r.totalValueUsd));
  const pnlAbsolute = sumDecimals(rows.map((r) => r.pnlAbsolute));

  return {
    stats: {
      totalValueUsd,
      nftValueUsd: sumDecimals(rows.map((r) => r.nftValueUsd)),
      tokenValueUsd: sumDecimals(rows.map((r) => r.tokenValueUsd)),
      // Absolute P&L is a sum of dollars, so it adds. A percentage does not: averaging nine
      // wallets' percentages would weight a $12 wallet the same as a $2,000 one. The portfolio
      // figure is derived from the two sums instead — the move, over what it moved from.
      pnlAbsolute,
      pnlPercentage: percentageOf(pnlAbsolute, totalValueUsd),
    },
    wallets: rows,
    incomplete: fanned.incomplete,
  };
}

/** Pull a list out of a response that might be the list, or might wrap it under a known key. */
export function listOf(value: unknown, keys: readonly string[]): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== "object") return [];
  for (const key of keys) {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

/**
 * Concatenate a list-shaped response across wallets, tagging each row with the wallet it came from.
 *
 * The tag is the point as much as the merge is: an offer in a list of six wallets' offers is not
 * actionable until you know which of your wallets it is on.
 */
export function combineList(
  fanned: Fanned<unknown>,
  keys: readonly string[],
  wrap: string,
): Record<string, unknown> {
  const items: unknown[] = [];
  for (const { wallet, value } of fanned.ok) {
    for (const item of listOf(value, keys)) {
      items.push(item !== null && typeof item === "object" ? { ...item, anchorWallet: wallet } : item);
    }
  }
  return { [wrap]: items, incomplete: fanned.incomplete };
}

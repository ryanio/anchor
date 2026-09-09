/**
 * Deriving the wallet from the PAT, when the config does not name one.
 *
 * Anchor cannot discover a person's wallets — `config.ts` says so, and it is the right default: the
 * service holds no wallet and asking the network which addresses belong to you is not a question
 * with an honest answer. But a wallet PAT is a token *issued to a wallet*, and it carries the
 * address as a claim. So there is one case where Anchor does know: the user already told it, by
 * storing the token.
 *
 * This is a **local decode, not a network read**, which is why it needs no scope and cannot fail
 * with a 403. `@opensea/sdk` documents the claim precisely:
 *
 *   Zitadel injects it as a top-level `wallet` claim (plaintext) via the `inject_wallet_claim`
 *   action, the same claim `opensea-mcp` and the os2-core REST API read. The `sub` claim is an
 *   account identifier, not a wallet address, so it must never be used as a fallback.
 *
 * We use the SDK's `extractWalletAddress` rather than reading `claims.wallet` ourselves, per
 * AGENTS.md: official tooling tracks the platform, a hand-rolled copy rots. In particular the `sub`
 * warning above is exactly the mistake a hand-rolled version makes.
 *
 * **Config always wins.** A derived wallet is a convenience for the empty case, never an override —
 * someone who has written an address down means it.
 *
 * Nothing here logs, returns, or embeds the token. The failure detail says which step failed, never
 * what was in it.
 */

import type { ChainIdentifier } from "@opensea/api-types";
import { decodeJwtPayload, extractWalletAddress } from "@opensea/sdk";
import { addressMatchesChain } from "./chains.ts";
import { looksLikeCredential } from "./keyring.ts";

/** Where the wallet list came from. Surfaced on `/health` so a reading can be checked. */
export type WalletSource = "config" | "token" | "none";

export interface ResolvedWallets {
  readonly wallets: readonly string[];
  readonly source: WalletSource;
  /** Why the token contributed nothing, when it did not. Safe to display; never contains the token. */
  readonly detail: string;
}

/**
 * Read the wallet claim out of a PAT.
 *
 * Every failure is ordinary and returns a reason rather than throwing: most tokens are fine, some
 * are issued without the claim, and a service that crashed on either would be a service that only
 * starts on the developer's machine.
 */
export function walletFromToken(
  pat: string | null,
  chains: readonly ChainIdentifier[],
): { address: string | null; detail: string } {
  if (pat === null || pat.trim() === "") {
    return { address: null, detail: "no token stored" };
  }

  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(pat);
  } catch {
    // A PAT is not required to be a JWT. An opaque token is not an error, it just carries nothing.
    return { address: null, detail: "token is not a JWT, so it carries no claims" };
  }

  const address = extractWalletAddress(claims);
  if (address === undefined || address === "") {
    return { address: null, detail: "token carries no wallet claim" };
  }

  // A token minted for an EVM wallet on a Solana-only config is a real mismatch, and silently
  // adopting it would produce 4xx responses far from the cause.
  if (!chains.some((chain) => addressMatchesChain(address, chain))) {
    return { address: null, detail: `token wallet does not match configured chains (${chains.join(", ")})` };
  }

  return { address, detail: "" };
}

/** Config wallets if there are any; otherwise whatever the token can supply. */
export function resolveWallets(
  configured: readonly string[],
  pat: string | null,
  chains: readonly ChainIdentifier[],
): ResolvedWallets {
  const named = configured.filter((wallet) => wallet.trim() !== "");
  if (named.length > 0) return { wallets: named, source: "config", detail: "" };

  const { address, detail } = walletFromToken(pat, chains);
  if (address === null) return { wallets: [], source: "none", detail };
  return { wallets: [address], source: "token", detail: "" };
}

/** What a stored token *is*, without saying what it contains. */
export interface TokenShape {
  readonly kind: "jwt" | "opaque" | "not-credential-shaped";
  readonly segments: number;
  readonly length: number;
  /** Only meaningful for a JWT. */
  readonly hasWalletClaim: boolean;
  /** One line for a terminal. Contains counts and verdicts, never token content. */
  readonly summary: string;
}

/**
 * Describe a stored token's shape for `--check-credentials`.
 *
 * "Present" is not "works" — the header of `checkCredentials` makes that point about the API key,
 * and the same gap swallowed a wallet PAT: `/health` reported the credential present, and it was a
 * shell command, because an interactive prompt read its own command line off a non-TTY stdin. A
 * shape line closes that gap for the PAT the way a live probe closes it for the API key.
 *
 * **Nothing here reveals the token.** Segment and character counts, whether the payload parsed, and
 * whether a wallet claim exists are facts *about* the value, not the value. That distinction is the
 * whole reason this can be printed at all.
 */
export function describeTokenShape(token: string): TokenShape {
  const length = token.length;

  if (!looksLikeCredential(token)) {
    return {
      kind: "not-credential-shaped",
      segments: 0,
      length,
      hasWalletClaim: false,
      summary:
        `not credential-shaped (${length} chars, contains whitespace or control characters). ` +
        "That is what a stored shell command looks like — re-run --set-pat and pipe the token in.",
    };
  }

  const segments = token.split(".").length;
  if (segments !== 3) {
    return {
      kind: "opaque",
      segments,
      length,
      hasWalletClaim: false,
      summary:
        `opaque token (${length} chars, ${segments} segment${segments === 1 ? "" : "s"}; a JWT has 3). ` +
        "Carries no claims, so no wallet address can be read from it.",
    };
  }

  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(token);
  } catch {
    return {
      kind: "opaque",
      segments,
      length,
      hasWalletClaim: false,
      summary: `three segments (${length} chars) but the payload did not decode as JSON, so it carries no claims.`,
    };
  }

  const wallet = extractWalletAddress(claims);
  const hasWalletClaim = wallet !== undefined && wallet !== "";
  const expiry = typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null;
  const expiryNote =
    expiry === null
      ? ""
      : `, ${expiry < new Date() ? "EXPIRED" : "expires"} ${expiry.toISOString().slice(0, 16)}Z`;

  return {
    kind: "jwt",
    segments,
    length,
    hasWalletClaim,
    summary: hasWalletClaim
      ? `JWT (${length} chars), wallet claim present${expiryNote}.`
      : `JWT (${length} chars), no wallet claim${expiryNote}. The token was not issued with a wallet injected.`,
  };
}

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

/**
 * Every external URL, in one place.
 *
 * This exists because renaming the game repository broke four links at once: GitHub redirects
 * repository URLs but does **not** redirect GitHub Pages, so the old play URL became a hard 404 and
 * each copy had to be found by hand. One constant means the next rename is a one-line change.
 *
 * Anything referenced from more than one place belongs here.
 */

const REPO = "https://github.com/ryanio/anchor";
const GAME_REPO = "https://github.com/ryanio/tidebreak";

export const LINKS = {
  site: "https://anchor.ryanio.com",

  repo: REPO,
  agents: `${REPO}/blob/main/AGENTS.md`,
  autonomy: `${REPO}/blob/main/docs/autonomy.md`,
  security: `${REPO}/blob/main/docs/security.md`,
  tokens: `${REPO}/blob/main/docs/tokens.md`,

  game: "https://ryanio.github.io/tidebreak/",
  gameRepo: GAME_REPO,

  omarchy: "https://omarchy.org",
  opensea: "https://opensea.io",

  ryan: "https://ryanio.com",
  x: "https://x.com/r_alx_z",
  github: "https://github.com/ryanio",
} as const;

/** Site-internal paths, so a rename here is also a single edit. */
export const PATHS = {
  home: "/",
  changelog: "/changelog.html",
  llms: "/llms.txt",
  diary: (slug: string) => `/diary/${slug}.html`,
  /** Every entry, not just the latest few the home page teases. */
  archive: "/diary/",
} as const;

/**
 * Pure logic for Anchor's bar widget.
 *
 * No QML imports, so `test/model.test.mjs` can drive every function under `node --test`. The QML
 * side is a thin renderer over this file: parsing, sanitising, formatting, the degraded-state
 * machine and the contrast floor all live here, where they can be tested without a compositor.
 *
 * Three rules govern this file, and each one is a test:
 *
 *   1. **Marketplace strings are hostile.** Collection and token names come from a public API and
 *      will contain markup, bidi overrides, zero-width characters, stacked combining marks and
 *      400-character names. Everything remote goes through `sanitize()` before it reaches a
 *      renderer, and nothing remote is ever interpolated into a shell command or a URL.
 *   2. **Money is never approximated through a float.** Amounts arrive as decimal or integer
 *      strings and stay strings: rounding is done digit by digit with a carry. Denominations are
 *      never converted — there is no exchange rate anywhere in this file, because a widget that
 *      invents one prints a number that is not true.
 *   3. **Staleness is shown, not hidden.** Every value the widget renders carries the age of the
 *      data behind it, and the bar says so rather than presenting an old number as live.
 */

// -------------------------------------------------------------------------------------------
// Untrusted text
// -------------------------------------------------------------------------------------------

/**
 * Characters that must be removed outright rather than turned into a space.
 *
 * Bidi controls (`U+202A`–`U+202E`, `U+2066`–`U+2069`, `U+200E`, `U+200F`, `U+061C`) let a name
 * reorder the text *around* it, so a collection can visually rewrite the label beside it. The
 * zero-width family (`U+200B`–`U+200D`, `U+2060`–`U+2064`, `U+FEFF`, `U+00AD`, `U+180E`) is
 * invisible, so it pads a name past a length check while rendering as something shorter.
 */
const REMOVE_RE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Control characters, replaced by a space rather than deleted so `"a\nb"` reads `"a b"` and not
 * `"ab"` — deleting the separator silently joins two words into a third that was never in the data.
 */
// The suppression must be one line: Biome reads only the last line of a `//` run as the directive,
// so a wrapped reason silences nothing and reports itself as unused.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point — this is the filter that keeps control characters out of a bar label, and a test asserts it works.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/** Combining marks. A long run of them ("Zalgo") paints far outside the line box and over the bar. */
const COMBINING_RE = /[\u0300-\u036F\u1AB0-\u1AFF\u20D0-\u20F0\uFE20-\uFE2F]/;

const DEFAULT_MAX_NAME = 28;

/**
 * Make one remote string safe to render in a fixed-height bar.
 *
 * Order matters: normalise first so a decomposed lookalike collapses, strip the invisible layer,
 * fold control characters to spaces, cap combining marks, collapse runs of whitespace, then
 * truncate by code point so a surrogate pair is never cut in half.
 */
function sanitize(value, maxLength) {
  if (typeof value !== "string" || value.length === 0) return "";

  let text = value;
  try {
    text = text.normalize("NFC");
  } catch (_err) {
    // A lone surrogate makes normalize throw. The raw string is still filtered below.
  }

  text = text.replace(REMOVE_RE, "").replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  text = capCombiningMarks(text);

  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : DEFAULT_MAX_NAME;
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars
    .slice(0, Math.max(1, limit - 1))
    .join("")
    .trimEnd()}…`;
}

/** At most two combining marks per base character. Two is enough for any real script. */
function capCombiningMarks(text) {
  let out = "";
  let run = 0;
  for (const ch of text) {
    if (COMBINING_RE.test(ch)) {
      if (run >= 2) continue;
      run++;
    } else {
      run = 0;
    }
    out += ch;
  }
  return out;
}

/** A currency symbol is remote data too. Anything that is not a plain ticker is dropped. */
function sanitizeSymbol(value) {
  const text = sanitize(value, 10);
  return /^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(text) ? text : "";
}

/** `0x1234…cdef` — enough to recognise a wallet, short enough for a bar tooltip. */
function shortAddress(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= 12) return sanitize(text, 12);
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

// -------------------------------------------------------------------------------------------
// Links. Never built from a remote display string.
// -------------------------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isSafeSlug(value) {
  return typeof value === "string" && SLUG_RE.test(value);
}

function isSafeAddress(value) {
  return typeof value === "string" && (EVM_RE.test(value) || BASE58_RE.test(value));
}

/**
 * A collection page, or `null`.
 *
 * `null` rather than a best-effort URL: an unexpected slug means the assumption behind the link is
 * wrong, and a widget that opens a browser at a guessed address is worse than one that does
 * nothing. The caller renders the row without a link instead.
 */
function collectionUrl(slug) {
  return isSafeSlug(slug) ? `https://opensea.io/collection/${slug}` : null;
}

function accountUrl(address) {
  return isSafeAddress(address) ? `https://opensea.io/${address}` : null;
}

// -------------------------------------------------------------------------------------------
// Money. String arithmetic only — see rule 2 in the module comment.
// -------------------------------------------------------------------------------------------

/**
 * A decimal literal. The leading `+` is not decoration: `/account/{address}/portfolio` returns
 * `pnlPercentage` as `"+1.01"`, and a regex that rejects it silently drops every gain.
 */
const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/;

/** `+` carries no information once the value is parsed; `-` does. Normalise to one spelling. */
function normalizeSign(sign) {
  return sign === "-" ? "-" : "";
}
const UNITS = ["", "K", "M", "B", "T"];

/** Increment a run of digits, carrying left. `"099"` → `"100"`, `"99"` → `"100"`. */
function incrementDigits(digits) {
  const out = digits.split("");
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] === "9") {
      out[i] = "0";
      continue;
    }
    out[i] = String(Number(out[i]) + 1);
    return out.join("");
  }
  return `1${out.join("")}`;
}

/**
 * Round a decimal *string* to `places`, half-up, without ever constructing a Number.
 *
 * `Number("12345678901234567.89")` has already lost digits before any rounding happens, and a
 * portfolio total is exactly the size where that starts to matter.
 */
function roundDecimal(value, places) {
  const m = DECIMAL_RE.exec(String(value ?? "").trim());
  if (!m) return null;

  const sign = normalizeSign(m[1]);
  const int = m[2];
  const frac = m[3] ?? "";
  const p = Number.isInteger(places) && places > 0 ? places : 0;

  if (frac.length <= p) return sign + int + (frac.length > 0 ? `.${frac}` : "");

  const keep = frac.slice(0, p);
  let combined = int + keep;
  if (Number(frac[p]) >= 5) combined = incrementDigits(combined);

  const intLength = combined.length - p;
  const newInt = combined.slice(0, intLength) || "0";
  const newFrac = combined.slice(intLength);
  return sign + newInt + (newFrac.length > 0 ? `.${newFrac}` : "");
}

/** Drop trailing fractional zeros. `"1.20"` → `"1.2"`, `"1.00"` → `"1"`. */
function trimZeros(value) {
  if (typeof value !== "string" || !value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * An integer amount in its smallest unit, rendered in whole units.
 *
 * This is the only conversion in this file, and it is not an exchange rate: moving a decimal point
 * within one denomination loses nothing and invents nothing.
 */
function formatUnits(raw, decimals) {
  const text = String(raw ?? "").trim();
  if (!/^-?\d+$/.test(text)) return null;

  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const d = Number.isInteger(decimals) && decimals > 0 ? decimals : 0;
  if (d === 0) return (negative ? "-" : "") + digits;

  const padded = digits.padStart(d + 1, "0");
  const cut = padded.length - d;
  return `${negative ? "-" : ""}${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

/**
 * Three significant digits and a magnitude suffix: `12345` → `12.3K`.
 *
 * A bar has room for about six characters of number. Rounding a balance into a friendly number is
 * fine; the exact figure is one hover away in the tooltip, which is why every caller keeps both.
 */
function compactDecimal(value) {
  const m = DECIMAL_RE.exec(String(value ?? "").trim());
  if (!m) return null;

  const sign = normalizeSign(m[1]);
  const int = m[2].replace(/^0+(?=\d)/, "");
  const frac = m[3] ?? "";

  // The tier is chosen from the digits, then checked against the rounding, because rounding can
  // move the number into the next one. $999.99 picked "no unit", rounded to 1000, and rendered as
  // "$1000.00" in a column of "$4.44K" — a magnitude format that had stopped being one.
  for (let tier = Math.min(UNITS.length - 1, Math.floor((int.length - 1) / 3)); ; tier++) {
    const shift = tier * 3;
    const newInt = int.slice(0, int.length - shift) || "0";
    const newFrac = int.slice(int.length - shift) + frac;

    const places = newInt.length >= 3 ? 0 : newInt.length === 2 ? 1 : 2;
    const rounded = roundDecimal(`${newInt}.${newFrac || "0"}`, places);
    const body = trimZeros(rounded ?? newInt);

    const grew = (DECIMAL_RE.exec(body)?.[2] ?? "").length > newInt.length;
    if (grew && tier < UNITS.length - 1) continue;
    return `${sign}${body}${UNITS[tier]}`;
  }
}

/** Group an integer part with thin separators, for the exact figure in a tooltip. */
function groupDigits(value) {
  const m = DECIMAL_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const grouped = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return normalizeSign(m[1]) + grouped + (m[3] ? `.${m[3]}` : "");
}

/**
 * Render an amount in the denomination it arrived in.
 *
 * `USD` gets a `$` because a bar with three characters of room needs it; every other denomination
 * is suffixed with its own ticker. Nothing is ever restated in another currency — the executor's
 * rule (`executor/src/types.ts`) is that denominations do not implicitly convert, and a read-only
 * widget has even less business inventing a rate than the thing that spends money does.
 */
/**
 * Pad a decimal string out to exactly `places` fraction digits.
 *
 * A *display* rule, applied after rounding and grouping and never to the value itself: nothing
 * downstream reads this string back. It exists because USD has exactly two decimal places by
 * definition, and `$125,430.5` is not a dollar amount — it is a number that happens to be in
 * dollars. Denominations without a fixed minor unit must not get this: ETH quoted to 8 places
 * would become `1.50000000`, which claims a precision the response never made.
 */
function padFraction(value, places) {
  const text = String(value ?? "");
  const dot = text.indexOf(".");
  const digits = dot === -1 ? 0 : text.length - dot - 1;
  if (digits >= places) return text;
  return (dot === -1 ? `${text}.` : text) + "0".repeat(places - digits);
}

/** Fixed minor units, by denomination. Only currencies whose minor unit is part of the unit. */
const FIXED_DECIMALS = { USD: 2 };

function formatMoney(amount, options) {
  const opts = options ?? {};
  const decimal = typeof amount === "string" ? amount : null;
  if (decimal === null || DECIMAL_RE.exec(decimal.trim()) === null) return "";

  const symbol = sanitizeSymbol(opts.symbol);
  const fixed = FIXED_DECIMALS[symbol];

  // `exact` shows the figure the API gave rather than a magnitude, but still caps the fraction:
  // a response with eighteen decimal places would otherwise run off the edge of the panel. The cap
  // is a display limit, not arithmetic — nothing downstream reads this string back. A denomination
  // with a fixed minor unit is rounded and padded to it; everything else keeps the 8-place cap and
  // its trailing zeros trimmed.
  let body = null;
  if (opts.exact === true) {
    const places = fixed === undefined ? 8 : fixed;
    body = groupDigits(roundDecimal(decimal, places) ?? decimal);
    if (body !== null && fixed !== undefined) body = padFraction(body, fixed);
  } else {
    body = compactDecimal(decimal);
    // The compact form is a magnitude *once it has a unit on it*: "$125.00K" would pad a rounding
    // rather than a cent. Below the first unit it is still an amount, and $11.1 is not a price.
    if (body !== null && fixed !== undefined && !/[KMBT]$/.test(body)) body = padFraction(body, fixed);
  }
  if (body === null) return "";

  if (symbol === "USD") return body.startsWith("-") ? `-$${body.slice(1)}` : `$${body}`;
  return symbol === "" ? body : `${body} ${symbol}`;
}

/** `"2.14"` → `{ arrow: "▲", text: "2.1%", direction: "up" }`. Sign read from the string. */
function formatChange(value) {
  const text = String(value ?? "").trim();
  if (DECIMAL_RE.exec(text) === null) return null;

  const negative = text.startsWith("-");
  const magnitude = trimZeros(roundDecimal(negative ? text.slice(1) : text, 1) ?? "0");
  const zero = /^0(\.0+)?$/.test(magnitude);

  return {
    direction: zero ? "flat" : negative ? "down" : "up",
    // Arrows rather than colour: a red/green pair fights whatever palette the desktop is wearing
    // and disappears entirely for the eight percent of men who cannot separate the two.
    arrow: zero ? "" : negative ? "▼" : "▲",
    text: `${magnitude}%`,
  };
}

// -------------------------------------------------------------------------------------------
// Time
// -------------------------------------------------------------------------------------------

/** How old a reading is: `"now"`, `"3m"`, `"2h"`, `"4d"`. */
function relativeAge(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** How long is left: `"2d 3h"`, `"1h 42m"`, `"8m"`, `"<1m"`, `"ended"`. */
function countdown(msRemaining) {
  const ms = Number(msRemaining);
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "ended";

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/**
 * Milliseconds from whatever the API called a timestamp.
 *
 * OpenSea mixes ISO 8601 strings with Unix seconds across endpoints, and a seconds value read as
 * milliseconds lands in 1970 — which renders as an offer that expired 55 years ago rather than one
 * closing in an hour. Anything below the year-2001 threshold in ms is therefore read as seconds.
 */
const SECONDS_CEILING = 1e12;

function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < SECONDS_CEILING ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== "string" || value.trim() === "") return null;

  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < SECONDS_CEILING ? n * 1000 : n;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// -------------------------------------------------------------------------------------------
// Contrast. The widget wears the user's Omarchy theme, so its floor has to be computed at runtime.
// -------------------------------------------------------------------------------------------

function channelToLinear(value) {
  const s = Math.min(1, Math.max(0, Number(value) || 0));
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. Channels are 0–1, matching QML's `color.r/g/b`. */
function relativeLuminance(color) {
  const c = color ?? {};
  return 0.2126 * channelToLinear(c.r) + 0.7152 * channelToLinear(c.g) + 0.0722 * channelToLinear(c.b);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function composite(fg, bg, alpha) {
  const a = Math.min(1, Math.max(0, Number(alpha)));
  return {
    r: (bg.r ?? 0) + ((fg.r ?? 0) - (bg.r ?? 0)) * a,
    g: (bg.g ?? 0) + ((fg.g ?? 0) - (bg.g ?? 0)) * a,
    b: (bg.b ?? 0) + ((fg.b ?? 0) - (bg.b ?? 0)) * a,
  };
}

/**
 * The most dimming that still clears `minRatio` against the bar, capped at what was asked for.
 *
 * The repo gates `theme/tokens.css` with `scripts/check-contrast.ts`, but that cannot help here:
 * the widget's colours are the *user's* theme, read at runtime, and a fade that is comfortable on
 * one Omarchy theme is invisible on another. So the same WCAG arithmetic runs on the live colours
 * and the fade is clamped to whatever the current theme can carry. On a theme where even full
 * opacity misses the floor, this returns 1.0 — the widget will not dim text it cannot afford to.
 */
function dimAlpha(foreground, background, desired, minRatio) {
  const want = Math.min(1, Math.max(0.05, Number(desired) || 0.55));
  const floor = Number(minRatio) > 0 ? Number(minRatio) : 3;

  for (let alpha = want; alpha < 1; alpha += 0.05) {
    if (contrastRatio(composite(foreground, background, alpha), background) >= floor) {
      return Math.round(alpha * 100) / 100;
    }
  }
  return 1;
}

// -------------------------------------------------------------------------------------------
// Depth, taken from the live Omarchy theme
// -------------------------------------------------------------------------------------------
//
// The panel used to paint every surface the same colour, which is what made it read flat: a ground,
// its rows and its sunken wells were all one value and only the text told you where you were.
//
// The fix is not an Anchor palette. Omarchy's themes already ship the layers — every stock theme
// defines `background`, `lighter_background` and `dark_background`, and in *both* light and dark
// themes `lighter_background` steps away from the ground toward the reader while `dark_background`
// steps away from it. (Checked against all 22 stock themes: catppuccin-latte's "lighter" is
// #dce0e8 against a #eff1f5 ground — darker, because on a light theme the alternate surface is the
// darker one. The names describe the palette, not the direction.) So the theme author's own choice
// is used where it is usable, and a step is derived from the ground only when it is not.

const HEX_RE = /^#?([0-9a-f]{6})$/i;

/** A `#rrggbb` string as QML-shaped channels, or null. Colour maths here is all 0–1. */
function hexToRgb(value) {
  const m = HEX_RE.exec(String(value ?? "").trim());
  if (m === null) return null;
  const n = Number.parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/**
 * The handful of keys Anchor needs out of an Omarchy theme's `colors.toml`.
 *
 * The shell's own `Color` singleton parses this file too, but keeps only foreground, background,
 * accent, urgent and muted — the surface layers never reach QML. Rather than duplicate its parser
 * this reads the same file for the four extra keys and nothing else, so a theme that omits them
 * still yields a usable result and no key here can turn into a colour at a call site.
 */
function parseThemeColors(raw) {
  const out = { mode: "dark", background: null, raised: null, sunken: null, line: null, foreground: null };
  const lines = String(raw ?? "").split("\n");
  for (const line of lines) {
    const kv = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (kv === null) continue;
    const key = kv[1];
    // Values are quoted hex or a bare word; a trailing comment is stripped before unquoting so
    // `background = "#1a1b26"  # deep` reads as the colour rather than as the whole line.
    const value = kv[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    if (key === "mode") out.mode = value === "light" ? "light" : "dark";
    else if (key === "background") out.background = hexToRgb(value);
    else if (key === "lighter_background") out.raised = hexToRgb(value);
    else if (key === "dark_background") out.sunken = hexToRgb(value);
    else if (key === "selection") out.line = hexToRgb(value);
    else if (key === "foreground") out.foreground = hexToRgb(value);
  }
  return out;
}

/** A surface is a *step*, not an edge: below this it is invisible, above it reads as a border. */
const SURFACE_MIN_RATIO = 1.03;
const SURFACE_MAX_RATIO = 1.5;
const SURFACE_TARGET_RATIO = 1.14;
/** A well that had to go *up* takes a shorter step than the card, so the pair stays ordered. */
const SUNKEN_REVERSED_RATIO = 1.07;
const LINE_MIN_RATIO = 1.25;
const LINE_MAX_RATIO = 4;
const LINE_TARGET_RATIO = 1.4;

/**
 * Blend `toward` into `ground` until the pair reaches `target` contrast, or as far as it goes.
 *
 * Used only when the theme has no usable value of its own. Stepping by alpha rather than by a fixed
 * lightness delta is what makes one rule work on both #000000 and #ffffff grounds: on a ground that
 * cannot go further in that direction the loop simply runs out and returns the closest it reached.
 */
function stepToward(ground, toward, target) {
  let best = ground;
  for (let alpha = 0.02; alpha <= 0.6; alpha += 0.01) {
    best = composite(toward, ground, alpha);
    if (contrastRatio(best, ground) >= target) return best;
  }
  return best;
}

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 1, g: 1, b: 1 };

/**
 * A derived step, with the direction reversed when the ground has no room left in it.
 *
 * `vantablack` is a #000000 ground and the `white` theme is #ffffff, so "a well is darker" and "a
 * card is lighter" are both false somewhere. When the preferred direction cannot reach the target,
 * the step goes the other way and takes a *shorter* one, which keeps the two layers apart and keeps
 * the well reading as the quieter of the pair rather than out-shouting the card above it.
 */
function derivedStep(ground, preferred, opposite, target, reversedTarget) {
  const first = stepToward(ground, preferred, target);
  if (contrastRatio(first, ground) >= SURFACE_MIN_RATIO) return first;
  return stepToward(ground, opposite, reversedTarget);
}

/** The theme's own value when it is a real step off *this* ground, otherwise one derived from it. */
function surfaceStep(ground, candidate, preferred, opposite, reversedTarget) {
  if (candidate !== null && candidate !== undefined) {
    const r = contrastRatio(candidate, ground);
    if (r >= SURFACE_MIN_RATIO && r <= SURFACE_MAX_RATIO) return candidate;
  }
  return derivedStep(ground, preferred, opposite, SURFACE_TARGET_RATIO, reversedTarget);
}

/**
 * The three surfaces the panel draws on, and the hairline between them.
 *
 * `ground` is passed in rather than taken from the theme file because the ground the panel actually
 * sits on is the shell's `popups.background`, which a theme may set independently of `background`
 * in its `shell.toml`. Deriving the steps from the file while painting on a different ground is how
 * a "themed" surface ends up not matching the thing it sits on.
 */
function panelSurfaces(ground, theme) {
  const t = theme ?? {};
  const light = t.mode === "light";
  // Raised moves toward the reader, sunken away from it. On a light theme both are darker than the
  // ground — a light UI has no headroom above white — which is exactly what the stock themes do.
  const raised = surfaceStep(
    ground,
    t.raised,
    light ? BLACK : WHITE,
    light ? WHITE : BLACK,
    SURFACE_TARGET_RATIO,
  );
  const sunken = surfaceStep(ground, t.sunken, BLACK, WHITE, SUNKEN_REVERSED_RATIO);
  // The theme's foreground makes the best derived rule — it is the one colour guaranteed to
  // contrast with the ground — and where there is no theme at all the direction is decided the
  // same way the surfaces decide it, by trying and reversing when the ground has no room.
  const fallbackLine = t.foreground ?? (light ? BLACK : WHITE);
  const fallbackLineOpposite = t.foreground ?? (light ? WHITE : BLACK);
  // A hairline is allowed a louder step than a surface, and a much wider band: `selection` is the
  // theme's own "this row is picked" colour, and across the stock themes that runs from barely
  // there (#292e42 on Tokyo Night) to a mid grey (#c0c0c0 on `white`). Both draw a legible rule.
  // The only thing a divider must not do is reach text contrast, which is what the ceiling is for.
  let line = t.line ?? null;
  if (line !== null) {
    const r = contrastRatio(line, ground);
    // The floor is not cosmetic: `vantablack` sets `selection` and `lighter_background` to the same
    // value, and a divider identical to the surface beside it disappears exactly where it is doing
    // its job. Below the floor the rule is derived instead, so a separator is always a separator.
    if (r < LINE_MIN_RATIO || r > LINE_MAX_RATIO) line = null;
  }
  if (line === null) {
    line = derivedStep(ground, fallbackLine, fallbackLineOpposite, LINE_TARGET_RATIO, LINE_TARGET_RATIO);
  }

  return { ground: ground, raised: raised, sunken: sunken, line: line };
}

// -------------------------------------------------------------------------------------------
// The service transport
// -------------------------------------------------------------------------------------------

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 8787;

function port(settings) {
  const value = Number(settings?.port);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
}

/**
 * The argv for one read. Loopback is hardcoded: `docs/security.md` binds the service to `127.0.0.1`
 * and there is no configuration here that could point the widget at a host that is not this one.
 *
 * `-w` appends the status code on its own line because the body of a non-2xx answer is where the
 * service explains itself — `--fail` would throw that away and leave the widget guessing.
 */
function curlArgs(path, settings) {
  const timeout = String(Math.max(2, Number(settings?.timeout) || 6));
  return [
    "curl",
    "-sS",
    "--max-time",
    timeout,
    "--noproxy",
    "*",
    "-H",
    "Accept: application/json",
    "-w",
    "\n%{http_code}",
    `http://${LOOPBACK}:${port(settings)}${path}`,
  ];
}

/** Split curl's `body\nSTATUS` output. Never throws — a torn response is just an unreadable one. */
function parseResponse(raw) {
  const text = String(raw ?? "");
  const cut = text.lastIndexOf("\n");
  if (cut < 0) return { ok: false, status: 0, data: null, meta: null, error: "no response" };

  const status = Number(text.slice(cut + 1).trim());
  const body = text.slice(0, cut);

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (_err) {
    return {
      ok: false,
      status: Number.isFinite(status) ? status : 0,
      data: null,
      meta: null,
      error: "unreadable response",
    };
  }

  if (status >= 200 && status < 300) {
    return {
      ok: true,
      status,
      data: parsed?.data ?? parsed,
      meta: parsed?.meta ?? null,
      error: null,
    };
  }

  return {
    ok: false,
    status: Number.isFinite(status) ? status : 0,
    data: null,
    meta: null,
    // The service's own message, not the marketplace's — but sanitised anyway, because it can
    // quote a slug from config and config is a file a person edits.
    error: sanitize(parsed?.error, 160) || `HTTP ${status}`,
  };
}

// -------------------------------------------------------------------------------------------
// Freshness
// -------------------------------------------------------------------------------------------

/**
 * Age of a reading in seconds, preferring the service's own envelope.
 *
 * `meta.ageSeconds` counts from the network fetch, so it keeps counting while the widget's copy
 * sits in a snapshot on disk across a reboot — which is exactly the case where a widget that
 * timed its own request would claim freshly-loaded stale data was new.
 */
function ageSeconds(entry, nowMs) {
  if (!entry) return null;
  const now = Number(nowMs) || Date.now();
  const local = Number(entry.receivedAt);
  const drift = Number.isFinite(local) && local > 0 ? Math.max(0, (now - local) / 1000) : 0;
  const reported = Number(entry.meta?.ageSeconds);
  if (Number.isFinite(reported) && reported >= 0) return Math.round(reported + drift);
  return Number.isFinite(local) && local > 0 ? Math.round(drift) : null;
}

/** True when the service flagged it stale, or when our copy has outlived `staleAfter`. */
function isStale(entry, nowMs, staleAfterSeconds) {
  if (!entry) return false;
  if (entry.meta?.stale === true) return true;
  const age = ageSeconds(entry, nowMs);
  const limit = Number(staleAfterSeconds) > 0 ? Number(staleAfterSeconds) : 900;
  return age !== null && age > limit;
}

// -------------------------------------------------------------------------------------------
// The degraded-state machine
// -------------------------------------------------------------------------------------------

const STATUS = {
  /** No snapshot yet and the first read has not landed. Shows the mark, no numbers. */
  STARTING: "starting",
  /** The service did not answer. Last-known values stay on screen, marked as such. */
  OFFLINE: "offline",
  /** The service answered, but Anchor is not configured far enough to show anything. */
  SETUP: "setup",
  /** Everything is configured; some of what is on screen has outlived its TTL. */
  STALE: "stale",
  READY: "ready",
};

function emptyState() {
  return {
    /** `/health`, or null if it has never answered. Local to the machine, so this is cheap. */
    health: null,
    /** Why the last `/health` read failed, if it did. Null once one succeeds. */
    healthError: null,
    /** Wall-clock ms of the last `/health` that answered at all, success or refusal. */
    reachedAt: 0,
    /** Envelopes: `{ data, meta, receivedAt, error, status }`. */
    portfolio: null,
    activity: null,
    collections: null,
    /** Token holdings, for the asset and chain breakdowns. Never on the bar. */
    balances: null,
    /** Wall-clock ms of the last read of any kind that succeeded. */
    updatedAt: 0,
    /**
     * What `systemctl --user` says about the service unit. Not a reading from the service — it is
     * a fact about this machine, and it is what decides whether setup shows a button or a command.
     */
    unit: { loaded: false, active: "", failed: false },
  };
}

/** Fold a `systemctl show` result into state. Its own function so a test can drive it. */
function applyUnitState(state, raw) {
  return Object.assign({}, state ?? emptyState(), { unit: parseUnitState(raw) });
}

/**
 * Every wallet Anchor is watching, as a list.
 *
 * The config used to name one wallet and the widget read one field. `wallets` is the list and
 * `wallet` is kept as its first element for anything that still asks — the same shape the project
 * already uses for `chain` → `chains`, so a hand-edited config with either spelling works.
 *
 * Watching all of them by default is as far as this goes: Anchor cannot *discover* a person's
 * wallets, because it holds no wallet credential and there is no endpoint that maps a human to
 * their addresses. Until a wallet adapter is connected, "all of them" means "all of the ones in the
 * config", and the setup step is widened rather than deleted. See widget/README.md.
 */
function walletList(health) {
  const list = health?.wallets;
  if (Array.isArray(list)) {
    const out = [];
    for (const entry of list) if (typeof entry === "string" && entry !== "") out.push(entry);
    if (out.length > 0) return out;
  }
  const single = health?.wallet;
  return typeof single === "string" && single !== "" ? [single] : [];
}

function credentials(health) {
  const creds = health?.credentials ?? {};
  return { apiKey: creds.apiKey === true, pat: creds.pat === true };
}

/**
 * Whether the API key we are told is *present* is actually *working*.
 *
 * `/health` reports a credential present when the keyring returned a non-empty string, which is
 * how a shell command once passed as an API key for a day (AGENTS.md, "Measuring things"). The only
 * evidence the widget has of a key that authenticates is a read that did not come back 401.
 *
 * So a 401 on any data route demotes the API key step from done back to current, with copy that
 * says the key is being rejected rather than missing. Presence and function are different claims
 * and the panel should not make the first one while meaning the second.
 */
function apiKeyRejected(state) {
  const s = state ?? emptyState();
  // Every data read, `balances` included. A route left out of this list is a route whose 401 the
  // panel would absorb silently while continuing to say the key is fine.
  for (const key of ["portfolio", "activity", "collections", "balances"]) {
    if (s[key] && s[key].status === 401) return true;
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// Actions the panel can take
// -------------------------------------------------------------------------------------------
//
// A setup step should *do* the thing, not describe it. Handing someone a `node …` command to copy
// out of a bar widget is the opposite of a desktop feature.
//
// A widget that spawns processes deserves a hard look, so the shape is deliberate. **The panel
// passes an identifier, never a command.** Every argv is assembled here from string literals, the
// table is closed, and an unknown id yields `null` — which means there is no expression anywhere in
// this project that turns marketplace text, a `/health` response, a `shell.json` setting or any
// other attacker-reachable value into something that runs. The one non-literal element is the
// config file's path, which is built from `$HOME`/`$XDG_CONFIG_HOME` and then validated below.
//
// What the allowed commands can do is bounded too. `systemctl --user` is the invoking user's own
// service manager: no polkit prompt, no privilege the user did not already have, and it can only
// start a unit that is already installed on the machine — the widget never writes one. None of this
// touches the read-only invariant either: starting the data service creates no code path from this
// widget to a signature, because the service refuses every non-GET before routing and holds no key.
//
// What is deliberately *not* here is any path that carries a credential. The API key is typed by a
// human into a terminal that writes it straight to the OS keyring; the widget opens that terminal
// and never sees the secret. A text field in the bar would put a credential inside the single
// process that draws the whole desktop, and passing it as an argument would put it in the process
// table. Neither is worth the saved click.

const SERVICE_UNIT = "anchor-service.service";

const ACTION = {
  /** `systemctl --user start` — this session only. */
  START_SERVICE: "start-service",
  /** `systemctl --user enable --now` — and every session after it. */
  ENABLE_SERVICE: "enable-service",
  /** Read the unit's state. Not user-visible; the widget polls it like any other reading. */
  PROBE_SERVICE: "probe-service",
  /** Opens a terminal on the interactive prompt. The secret never comes near this process. */
  SET_API_KEY: "set-api-key",
  /** Opens `~/.config/anchor/config.json` in whichever editor Omarchy is configured to use. */
  EDIT_CONFIG: "edit-config",
};

/**
 * Where the service's config lives, from the environment rather than from any setting.
 *
 * Validated even so: an absolute path, no `..` segment, no control characters. `$XDG_CONFIG_HOME`
 * is the user's own variable and not an attack surface in any realistic sense, but this value is
 * the single non-literal that reaches `execDetached`, and "realistically safe" is the argument that
 * precedes every injection. Returns null rather than guessing, and a null runs nothing.
 */
function configFilePath(env) {
  const e = env ?? {};
  const base =
    typeof e.configHome === "string" && e.configHome !== ""
      ? e.configHome
      : typeof e.home === "string" && e.home !== ""
        ? `${e.home}/.config`
        : "";
  if (base === "") return null;
  const path = `${base}/anchor/config.json`;
  if (path.charAt(0) !== "/") return null;
  if (path.split("/").includes("..")) return null;
  // Its own regex, not the shared `CONTROL_RE`: that one carries the `g` flag, and `.test()` on a
  // global regex advances `lastIndex`, so alternate calls return false on identical input.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point — a path is what reaches execDetached, and a test asserts a control character is rejected.
  if (/[\u0000-\u001F\u007F-\u009F]/.test(path)) return null;
  return path;
}

/**
 * The argv for an action id, or null.
 *
 * `null` is the whole safety property: the caller runs what this returns and nothing else, so an id
 * that is not in this table cannot become a command however it was produced.
 */
function actionArgv(id, env) {
  switch (id) {
    case ACTION.START_SERVICE:
      return ["systemctl", "--user", "start", SERVICE_UNIT];
    case ACTION.ENABLE_SERVICE:
      return ["systemctl", "--user", "enable", "--now", SERVICE_UNIT];
    case ACTION.PROBE_SERVICE:
      return ["systemctl", "--user", "show", SERVICE_UNIT, "--property=LoadState", "--property=ActiveState"];
    case ACTION.SET_API_KEY:
      // `omarchy-launch-terminal` is Omarchy's own launcher and takes the command as argv, so the
      // prompt runs in a real TTY. That matters beyond convenience: `--set-api-key` refuses a value
      // that arrives with whitespace or control characters, which is how it caught a wrapper
      // feeding it its own command line (AGENTS.md, "Measuring things").
      return ["omarchy-launch-terminal", "anchor-service", "--set-api-key"];
    case ACTION.EDIT_CONFIG: {
      const path = configFilePath(env);
      return path === null ? null : ["omarchy-launch-editor", path];
    }
    default:
      return null;
  }
}

/**
 * `systemctl show` output as the two facts the panel needs.
 *
 * `loaded` is the honest test for "is there a button worth showing": a unit file that exists can be
 * named, and one that does not cannot. It is *not* a promise that starting will work — a unit whose
 * `ExecStart` is missing loads fine and fails on start — so `failed` is read back afterwards and
 * the step says so rather than the panel claiming a success it did not observe.
 */
function parseUnitState(raw) {
  const out = { loaded: false, active: "", failed: false };
  if (typeof raw !== "string") return out;
  for (const line of raw.split("\n")) {
    const kv = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (kv === null) continue;
    if (kv[1] === "LoadState") out.loaded = kv[2] === "loaded";
    else if (kv[1] === "ActiveState") out.active = kv[2];
  }
  out.failed = out.active === "failed";
  return out;
}

/**
 * What the user still has to do, in the order they have to do it.
 *
 * A fresh install is missing all of this, and the honest answer is a short sequence rather than an
 * error: nothing has gone wrong, the thing simply has not been set up yet.
 *
 * Two decisions shape the copy. First, every `label` says what the step *gets you*, not what it
 * configures — "See what your wallet is worth" rather than "Wallet token stored" — because the
 * name of a setting is only meaningful to someone who already knows why they want it. Second, the
 * required path is three steps and everything else is explicitly optional, because collection
 * floors work with nothing but an API key. A partly-configured Anchor is useful, and saying so is
 * the difference between "broken" and "not finished".
 */
function setupSteps(state) {
  const health = state?.health ?? null;
  const creds = credentials(health);
  const reachable = health !== null;
  const rejected = creds.apiKey && apiKeyRejected(state);

  const unit = state?.unit ?? { loaded: false, active: "", failed: false };

  return [
    {
      key: "service",
      label: "Start the data service",
      // Three details for three different situations, and the middle one is the one that matters:
      // a unit can load and still fail to start, and a panel that showed a button, ran it, and then
      // said nothing would be claiming a success it never observed.
      detail: unit.failed
        ? "It is installed but failed to start. `systemctl --user status anchor-service` says why."
        : unit.loaded
          ? "Everything Anchor shows is read through it, on loopback."
          : "Everything Anchor shows is read through it, on loopback. Install Anchor's service unit and this becomes a button.",
      // `missing` is a phrase that reads as a sentence, because it is one — deriving it from
      // `label` produced "opensea api key stored is missing".
      missing: "the data service is not running",
      done: reachable,
      // Offered only when the unit is actually installed. A button that cannot work is worse than
      // no button: it moves the failure from "not set up yet" to "this thing is broken".
      action: unit.loaded ? { id: ACTION.START_SERVICE, label: "Start Anchor" } : null,
      secondary: unit.loaded ? { id: ACTION.ENABLE_SERVICE, label: "and at login" } : null,
      hint: unit.loaded ? "systemctl --user start anchor-service" : "node service/src/index.ts",
      optional: false,
    },
    {
      // Presence and function are separate claims. A key OpenSea is rejecting sends this step back
      // to `current` with copy that says so, rather than ticking it and leaving the user to wonder
      // why a fully configured Anchor shows nothing.
      key: "apiKey",
      label: rejected ? "Replace your OpenSea API key" : "Add your OpenSea API key",
      detail: rejected
        ? "The stored key is being rejected. Nothing will load until it is replaced."
        : "The only credential Anchor needs. Opens a terminal — the key goes straight to your keyring and never through this widget.",
      missing: rejected ? "the stored API key is being rejected" : "needs an OpenSea API key",
      done: reachable && creds.apiKey && !rejected,
      // A step that can be started from the panel is, even though it cannot be *finished* there.
      // Typing a secret into the process that draws the desktop is not a shortcut worth having, so
      // the widget opens the prompt and then has nothing more to do with it.
      action: { id: ACTION.SET_API_KEY, label: rejected ? "Replace the key" : "Enter the key" },
      secondary: null,
      hint: rejected ? "anchor-service --check-credentials" : "anchor-service --set-api-key",
      optional: false,
    },
    {
      key: "wallet",
      label: "Add a wallet to watch",
      detail: "Anchor watches every wallet you list, and never holds their keys.",
      missing: "no wallet configured",
      done: reachable && walletList(health).length > 0,
      action: { id: ACTION.EDIT_CONFIG, label: "Open config" },
      secondary: null,
      // The button opens this file, so the footnote is the path rather than a sentence about it.
      hint: "~/.config/anchor/config.json",
      optional: false,
    },
    // There is deliberately no wallet-PAT step here. Anchor used to ask for one and call the
    // account routes "closed" without it; re-measured with a key that actually authenticates, every
    // route this service calls needs the API key and nothing else (service/src/auth.ts). Removing
    // that step is the single biggest thing that shortened this sequence — the fix for "a lot of
    // setup steps in a row" was a step that never needed to exist, not a better way to draw it.
    {
      key: "collections",
      label: "Watch a few collections",
      detail: "Their floor prices show up in this panel.",
      missing: "no collections watched",
      done: reachable && Array.isArray(health.collections) && health.collections.length > 0,
      action: { id: ACTION.EDIT_CONFIG, label: "Open config" },
      secondary: null,
      hint: "`collections` in ~/.config/anchor/config.json",
      optional: true,
      /** What skipping this costs, as a noun phrase. See `optionalSummary`. */
      benefit: "floor prices",
    },
  ];
}

/**
 * What the collapsed optional steps are offering, as one line.
 *
 * Derived from the steps rather than written beside them. The hand-maintained version promised
 * "portfolio value, incoming offers, floor prices" and kept saying it after the steps behind the
 * first two were deleted — a caption outliving the thing it captioned. Anything that summarises a
 * list has to be computed from that list or it is a comment that renders.
 */
function optionalSummary(state) {
  const benefits = [];
  for (const step of setupSteps(state)) {
    if (step.optional && !step.done && step.benefit) benefits.push(step.benefit);
  }
  return benefits.join(" · ");
}

/**
 * The setup sequence as something with a position in it, rather than a list of equal rows.
 *
 * A vertical stack of five identical rows reads as a chore, and it hides the two facts that
 * actually matter: how far along you are, and which single thing to do next. So completed required
 * steps leave the queue entirely — the progress segments are what record them — and exactly one
 * step is `current` at a time. The optional steps are collected separately so the required path
 * can be shown short and the rest deferred behind one line.
 */
function setupProgress(state) {
  const steps = setupSteps(state);
  const required = [];
  const optional = [];
  for (const step of steps) (step.optional ? optional : required).push(step);

  const doneCount = required.filter((step) => step.done).length;
  // The first required step not yet done. Everything after it is `upcoming`: showing a command for
  // a step that cannot succeed until an earlier one does is an invitation to run it and fail.
  const currentIndex = required.findIndex((step) => !step.done);

  return {
    required: required.map((step, index) =>
      Object.assign({}, step, {
        number: index + 1,
        state: step.done ? "done" : index === currentIndex ? "current" : "upcoming",
      }),
    ),
    optional: optional.map((step) => Object.assign({}, step, { state: step.done ? "done" : "optional" })),
    total: required.length,
    done: doneCount,
    /** 1-based position for "step 2 of 3", or `total` once there is nothing left to do. */
    position: currentIndex === -1 ? required.length : currentIndex + 1,
    complete: currentIndex === -1,
    optionalRemaining: optional.filter((step) => !step.done).length,
  };
}

/**
 * One label for the whole widget.
 *
 * Precedence is deliberate and is the reason this is a function rather than a chain of ternaries
 * at the call site. Unreachable outranks unconfigured, because when the service is down we cannot
 * know what is configured; missing credentials outrank staleness, because stale data is a
 * refinement of data we have and a missing key means we have none.
 */
function statusOf(state, nowMs, settings) {
  const s = state ?? emptyState();
  const now = Number(nowMs) || Date.now();

  if (s.health === null) {
    // `healthError` is what separates "not asked yet" from "asked and got nothing". Inferring it
    // from whether some *other* read had already failed worked, but only by accident: it left the
    // widget saying "reading…" indefinitely whenever /health was the only request in flight.
    if (s.healthError !== null) return STATUS.OFFLINE;
    return s.updatedAt > 0 ? STATUS.OFFLINE : STATUS.STARTING;
  }
  if (s.healthError !== null) return STATUS.OFFLINE;

  // Derived from the steps rather than re-tested here, so "what the panel asks for" and "what the
  // bar says is wrong" can never disagree — they did, while the PAT step existed.
  if (setupSteps(s).some((step) => !step.optional && !step.done)) return STATUS.SETUP;

  const staleAfter = Number(settings?.staleAfter) || 900;
  const entries = [s.portfolio, s.activity, s.collections].filter((e) => e !== null);
  if (entries.length === 0) return STATUS.STARTING;
  if (entries.some((e) => isStale(e, now, staleAfter))) return STATUS.STALE;
  return STATUS.READY;
}

/**
 * One line saying what is true right now, without repeating the word "Anchor".
 *
 * This is the panel's subtitle and the body of the bar tooltip. In the healthy states it is not a
 * status at all but a count — how much is waiting for a decision — because "everything is fine" is
 * the least useful thing a status line can say.
 */
function statusDetail(state, nowMs, settings) {
  const status = statusOf(state, nowMs, settings);
  const s = state ?? emptyState();
  const now = Number(nowMs) || Date.now();

  switch (status) {
    case STATUS.STARTING:
      return "reading…";
    case STATUS.OFFLINE:
      // Short on purpose. This is a hero subtitle and a one-line tooltip, both of which elide, and
      // the panel already prints which wallets the number is for and how old it is directly under
      // it. The long form said all of that a second time and ran off the end doing it:
      // "DATA SERVICE UNREACHABLE · LAST READING NOW…".
      return s.updatedAt > 0 ? "data service not answering" : "data service not running";
    case STATUS.SETUP: {
      const pending = setupSteps(s).filter((step) => !step.optional && !step.done);
      return pending.length === 0 ? "setting up" : pending[0].missing;
    }
    default: {
      const offers = offerCount(s);
      const parts = [];
      if (status === STATUS.STALE) parts.push("stale, retrying");
      if (offers > 0) parts.push(`${offers} offer${offers === 1 ? "" : "s"}`);
      // The activity count only earns its place when nothing more important is competing for the
      // line — in a degraded state the reason matters more, and the line elides if both are there.
      if (status === STATUS.READY) {
        const events = activityCount(s, now, settings);
        const hours = Number(settings?.activityWindowHours) || 24;
        // Zero is not news. "0 events in 24h" is a line that costs a reader something and tells
        // them nothing they did not already get from the absence of a list.
        if (events > 0) parts.push(`${events} event${events === 1 ? "" : "s"} in ${hours}h`);
      }
      // A healthy, quiet wallet still deserves a subtitle that says the widget is working.
      if (parts.length === 0 && status === STATUS.READY) return "up to date";
      return parts.join(" · ");
    }
  }
}

/** The bar tooltip's first line. Never a stack trace, never a raw upstream message. */
function statusSummary(state, nowMs, settings) {
  const detail = statusDetail(state, nowMs, settings);
  return detail === "" ? "Anchor" : `Anchor — ${detail}`;
}

// -------------------------------------------------------------------------------------------
// The portfolio, broken down
// -------------------------------------------------------------------------------------------
//
// Three views of one number, and each says what it covers, because they do not all cover the same
// thing:
//
//   **Type** is the whole portfolio. `/portfolio/value` returns `nftValueUsd` and `tokenValueUsd`
//   and they sum to the total, so this is the only view that accounts for everything.
//
//   **Assets** and **Chains** come from `/balances`, which is the *token* half. They are labelled
//   as such and their own total is shown, rather than being presented as shares of the portfolio.
//   Drawing NFT value into a chain split would need per-chain NFT valuation, which the endpoint
//   does not return; inventing it from what is available is exactly the kind of plausible number
//   this widget exists not to print.
//
// The form is a labelled split bar, never a pie. Two or three parts of a whole is a ratio, and a
// pie of two slices is the canonical way to make a ratio harder to read than the sentence it
// replaced. Every segment carries its own name, value and share as text; the bar is the shape of
// the answer and the rows are the answer.

const BREAKDOWNS = [
  { key: "type", label: "type" },
  { key: "wallet", label: "wallets" },
  { key: "asset", label: "assets" },
  { key: "chain", label: "chains" },
];

/** Sum a list of decimal strings without going through a float. See rule 2 in the module comment. */
function sumDecimals(values) {
  let total = "0";
  for (const value of values) total = addDecimals(total, value);
  return total;
}

/** `a + b` on two non-negative decimal strings, digit by digit with a carry. */
function addDecimals(a, b) {
  const ma = DECIMAL_RE.exec(String(a ?? "").trim());
  const mb = DECIMAL_RE.exec(String(b ?? "").trim());
  if (!ma || !mb || ma[1] === "-" || mb[1] === "-") return ma && ma[1] !== "-" ? String(a) : "0";

  const fracLen = Math.max((ma[3] ?? "").length, (mb[3] ?? "").length);
  const pad = (m) => m[2] + (m[3] ?? "").padEnd(fracLen, "0");
  const da = pad(ma);
  const db = pad(mb);
  const width = Math.max(da.length, db.length);
  const xa = da.padStart(width, "0");
  const xb = db.padStart(width, "0");

  let carry = 0;
  let out = "";
  for (let i = width - 1; i >= 0; i--) {
    const sum = Number(xa[i]) + Number(xb[i]) + carry;
    out = String(sum % 10) + out;
    carry = sum >= 10 ? 1 : 0;
  }
  if (carry > 0) out = "1" + out;

  const cut = out.length - fracLen;
  const int = out.slice(0, cut).replace(/^0+(?=\d)/, "");
  const frac = out.slice(cut);
  return fracLen === 0 ? int : trimZeros(`${int}.${frac}`);
}

/**
 * A share, 0–1, as a float.
 *
 * The one place a float is allowed, and only because nothing is printed from it: it sets the width
 * of a rectangle. The percentage beside it is rounded from the same number and is a share, not an
 * amount — `Model.formatMoney` still prints every figure from the decimal string.
 */
function share(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!isFinite(p) || !isFinite(t) || t <= 0) return 0;
  return Math.min(1, Math.max(0, p / t));
}

/** Token holdings from `/balances`, largest first. Every string here is remote and sanitised. */
function balanceRows(state, settings) {
  const data = state?.balances?.data ?? null;
  const list = Array.isArray(data) ? data : (data?.tokens ?? data?.balances ?? data?.items ?? null);
  if (!Array.isArray(list)) return [];
  const maxName = Number(settings?.maxNameLength) || DEFAULT_MAX_NAME;

  const out = [];
  for (const row of list) {
    const usd = pickDecimal(row, ["usdValue", "usd_value"]);
    if (usd === null) continue;
    const symbol = sanitizeSymbol(pickString(row, ["symbol"]));
    const name = sanitize(pickString(row, ["name"]), maxName);
    out.push({
      // The ticker is the shortest true name and the one people read; the long name is the
      // fallback, and the address never appears — it is an identifier, not a label.
      label: symbol !== "" ? symbol : name !== "" ? name : "token",
      chain: sanitize(pickString(row, ["chain"]), 16) || "unknown",
      usd,
    });
  }
  out.sort((a, b) => Number(b.usd) - Number(a.usd));
  return out;
}

/** How many rows a split can carry before the tail stops being readable. */
const BREAKDOWN_LIMIT = 5;

/**
 * One view of the portfolio: rows, their shares, and what the view actually covers.
 *
 * `scope` is not decoration. It is the sentence that would have made a fabricated total obvious,
 * and it is why every view states its own total rather than borrowing the headline's.
 */
function portfolioBreakdown(state, settings, mode) {
  const portfolio = readPortfolio(state?.portfolio ?? null);
  const usd = { symbol: "USD" };

  if (mode === "type") {
    const parts = [];
    if (portfolio.nftValue !== null) parts.push({ label: "NFTs", value: portfolio.nftValue });
    if (portfolio.tokenValue !== null) parts.push({ label: "Tokens", value: portfolio.tokenValue });
    if (parts.length === 0) return { rows: [], total: null, scope: "", symbol: "USD" };
    const total = portfolio.total ?? sumDecimals(parts.map((p) => p.value));
    return {
      rows: parts.map((p) => ({
        label: p.label,
        value: p.value,
        text: formatMoney(p.value, usd),
        share: share(p.value, total),
      })),
      total,
      totalText: formatMoney(total, { symbol: "USD", exact: true }),
      scope: "everything Anchor can see",
      symbol: "USD",
    };
  }

  if (mode === "wallet") {
    // Straight from the service, which is the only place it can come from: it fans out per wallet
    // and reports each one beside the sum. Nothing here divides a total by anything — every row is
    // a figure some wallet's own portfolio page would show.
    const rows = walletValues(state);
    if (rows.length === 0) return { rows: [], total: null, scope: "", symbol: "USD" };
    const total = sumDecimals(rows.map((r) => r.usd));
    const head = rows.slice(0, BREAKDOWN_LIMIT);
    const tail = rows.slice(BREAKDOWN_LIMIT);
    const out = head.map((row) => ({
      label: shortAddress(row.address),
      value: row.usd,
      text: formatMoney(row.usd, usd),
      share: share(row.usd, total),
    }));
    if (tail.length > 0) {
      const rest = sumDecimals(tail.map((row) => row.usd));
      out.push({
        label: `${tail.length} more`,
        value: rest,
        text: formatMoney(rest, usd),
        share: share(rest, total),
      });
    }
    return {
      rows: out,
      total,
      totalText: formatMoney(total, { symbol: "USD", exact: true }),
      scope: "everything Anchor can see, by wallet",
      symbol: "USD",
    };
  }

  const balances = balanceRows(state, settings);
  if (balances.length === 0) return { rows: [], total: null, scope: "", symbol: "USD" };

  let grouped = balances;
  if (mode === "chain") {
    const byChain = {};
    const order = [];
    for (const row of balances) {
      if (byChain[row.chain] === undefined) {
        byChain[row.chain] = "0";
        order.push(row.chain);
      }
      byChain[row.chain] = addDecimals(byChain[row.chain], row.usd);
    }
    grouped = order.map((chain) => ({ label: chain, usd: byChain[chain] }));
    grouped.sort((a, b) => Number(b.usd) - Number(a.usd));
  }

  const total = sumDecimals(grouped.map((row) => row.usd));

  // Past the limit the tail is folded into one row rather than dropped: a split whose parts do not
  // add up to its own stated total is worse than a coarse one.
  const head = grouped.slice(0, BREAKDOWN_LIMIT);
  const tail = grouped.slice(BREAKDOWN_LIMIT);
  const rows = head.map((row) => ({
    label: row.label,
    value: row.usd,
    text: formatMoney(row.usd, usd),
    share: share(row.usd, total),
  }));
  if (tail.length > 0) {
    const rest = sumDecimals(tail.map((row) => row.usd));
    rows.push({
      label: `${tail.length} more`,
      value: rest,
      text: formatMoney(rest, usd),
      share: share(rest, total),
    });
  }

  return {
    rows,
    total,
    totalText: formatMoney(total, { symbol: "USD", exact: true }),
    // Said on every view that is not the whole portfolio, every time it is drawn.
    scope: "tokens only — NFT value is not broken down by " + (mode === "chain" ? "chain" : "asset"),
    symbol: "USD",
  };
}

/**
 * Where the number on screen came from, in one line.
 *
 * A total is a claim about specific addresses at a specific moment, and a panel that shows the
 * figure without either is asking to be believed rather than read. This is the line that would
 * have made two addresses nobody configured obvious at a glance.
 */
function provenance(state, nowMs, settings) {
  const wallets = walletList(state?.health);
  const missing = missingWallets(state).length;
  const parts = [];
  if (wallets.length === 1) parts.push(shortAddress(wallets[0]));
  // "8 of 9 wallets", not "9 wallets", when one did not answer. The service reports which ones it
  // could not read rather than trimming them, and this is the half that makes reporting it worth
  // anything: a total silently missing a wallet is exactly the bug the fan-out exists to fix.
  else if (wallets.length > 1) {
    parts.push(
      missing > 0 ? `${wallets.length - missing} of ${wallets.length} wallets` : `${wallets.length} wallets`,
    );
  }

  const age = ageSeconds(state?.portfolio, nowMs);
  if (age !== null) parts.push(`as of ${relativeAge(age)}`);
  return parts.join("  ·  ");
}

// -------------------------------------------------------------------------------------------
// Readings
// -------------------------------------------------------------------------------------------

/**
 * Pull a portfolio total out of `/portfolio/value` without assuming one field name.
 *
 * OpenSea's portfolio response has changed shape more than once and `@opensea/sdk` camelises what
 * it returns, so both spellings are tried. Every candidate is kept as a string: `JSON.parse` has
 * already turned a JSON number into a float, so the string form is preferred wherever the API
 * offers one, and a number is only stringified as a last resort.
 */
/**
 * Each wallet's own total, biggest first.
 *
 * The service fans out per wallet and reports them beside the sum, so this reads rather than
 * derives. Sorted by value because a nine-row list ordered by however the JWT happened to list them
 * is a list nobody reads past the third row.
 */
function walletValues(state) {
  const data = state?.portfolio?.data ?? null;
  const rows = Array.isArray(data?.wallets) ? data.wallets : [];
  return rows
    .map((row) => ({ address: sanitize(row?.address, 64), usd: pickDecimal(row, TOTAL_KEYS) }))
    .filter((row) => row.address !== "" && row.usd !== null)
    .sort((a, b) => Number(b.usd) - Number(a.usd));
}

/**
 * Wallets the total on screen does not include.
 *
 * The service says so rather than trimming them; this is the half that makes saying so worth
 * anything. A total quietly missing a wallet is the bug the fan-out exists to fix, and a total
 * visibly missing one is a different, honest thing.
 */
function missingWallets(state) {
  const data = state?.portfolio?.data ?? null;
  const rows = Array.isArray(data?.incomplete) ? data.incomplete : [];
  return rows.map((w) => sanitize(w, 64)).filter((w) => w !== "");
}

const TOTAL_KEYS = ["totalValueUsd", "total_value_usd", "netWorthUsd", "net_worth_usd", "value"];
const NFT_VALUE_KEYS = ["nftValueUsd", "nft_value_usd"];
const TOKEN_VALUE_KEYS = ["tokenValueUsd", "token_value_usd"];
const CHANGE_KEYS = ["pnlPercentage", "pnl_percentage", "percentChange", "percent_change"];

/**
 * The first of `keys` that holds a decimal, as a string.
 *
 * Strings are preferred over numbers because `JSON.parse` has already rounded a JSON number by the
 * time this runs, and the API is inconsistent about which it sends: portfolio totals are strings,
 * `collectionStats.total.floorPrice` is a double. A small double stringifies as `"1e-7"`, which is
 * a decimal to a human and not one to `DECIMAL_RE`, so it is expanded rather than dropped.
 */
function pickDecimal(source, keys) {
  if (source === null || typeof source !== "object") return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && DECIMAL_RE.test(value.trim())) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return numberToDecimal(value);
  }
  return null;
}

/** `String(1e-7)` is `"1e-7"`. Expand it, so a floor price of 0.0000001 renders as a number. */
function numberToDecimal(value) {
  const plain = String(value);
  if (!/e/i.test(plain)) return plain;
  // 20 is the maximum toFixed accepts, and is well past any denomination's precision.
  return trimZeros(value.toFixed(20)) || "0";
}

/**
 * `{ total, symbol, change }` from a `/portfolio/value` envelope, or nulls.
 *
 * A missing total is not an error — an account with nothing in it, or a response whose shape moved,
 * both render as "no value yet" rather than as a broken widget.
 */
function readPortfolio(entry) {
  const data = entry?.data ?? null;
  const source = data === null ? null : (data.stats ?? data.portfolio ?? data);
  const total = pickDecimal(source, TOTAL_KEYS);
  const change = pickDecimal(source, CHANGE_KEYS);

  return {
    total,
    // The endpoint quotes USD and says so in its field names (`totalValueUsd`). That is stated,
    // not converted: no rate is applied anywhere here, and the split below is in the same unit as
    // the total, so showing them together adds no claim the response did not already make.
    symbol: "USD",
    nftValue: pickDecimal(source, NFT_VALUE_KEYS),
    tokenValue: pickDecimal(source, TOKEN_VALUE_KEYS),
    // Which window the P&L covers. Rendering a change without it invites reading a week as a day.
    timeframe: sanitize(source?.timeframe, 8),
    change: change === null ? null : formatChange(change),
  };
}

const EVENT_LIST_KEYS = ["assetEvents", "asset_events", "events", "items"];

function eventList(data) {
  if (Array.isArray(data)) return data;
  if (data === null || typeof data !== "object") return [];
  for (const key of EVENT_LIST_KEYS) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

const EVENT_TIME_KEYS = ["eventTimestamp", "event_timestamp", "createdDate", "created_date", "timestamp"];
const EXPIRY_KEYS = [
  "expirationDate",
  "expiration_date",
  "expirationTime",
  "expiration_time",
  "endTime",
  "end_time",
  "closingDate",
  "closing_date",
];

function pickTime(source, keys) {
  if (source === null || typeof source !== "object") return null;
  for (const key of keys) {
    const ms = toMillis(source[key]);
    if (ms !== null) return ms;
  }
  return null;
}

/** True for an event that is somebody bidding on the user's things rather than the user acting. */
function isIncomingOffer(event, wallet) {
  const type = String(event?.eventType ?? event?.event_type ?? "").toLowerCase();
  if (type !== "order") return false;

  const orderType = String(event?.orderType ?? event?.order_type ?? "").toLowerCase();
  if (!orderType.includes("offer") && !orderType.includes("bid")) return false;

  const maker = String(event?.maker ?? "").toLowerCase();
  // Takes one wallet or the whole watched list. It has to be the list, not one call per wallet
  // OR-ed together: with two wallets, an offer *made* by the first is "not made by the second",
  // so any per-wallet test combined with `some` counts a person's own bid as incoming to them.
  const owners = [];
  for (const entry of Array.isArray(wallet) ? wallet : [wallet]) {
    const owner = String(entry ?? "").toLowerCase();
    if (owner !== "") owners.push(owner);
  }
  // An offer the user made themselves is not an incoming offer. An unknown maker is counted:
  // under-reporting a deadline is worse than over-reporting one.
  if (maker === "" || owners.length === 0) return true;
  return owners.indexOf(maker) === -1;
}

/**
 * Everything with a clock on it, soonest first.
 *
 * Incoming offers expire, and an expiry the user does not see is the one thing a bar widget is
 * actually for. Anything already past, or further out than `windowHours`, is dropped: a countdown
 * reading `41d` is noise, and one reading `ended` is a lie about a decision still being available.
 */
function deadlines(state, nowMs, settings) {
  const now = Number(nowMs) || Date.now();
  const windowMs = (Number(settings?.deadlineWindowHours) || 48) * 3600000;
  const wallets = walletList(state?.health);
  const maxName = Number(settings?.maxNameLength) || DEFAULT_MAX_NAME;
  const names = collectionNames(state, settings);

  const out = [];
  for (const event of eventList(state?.activity?.data)) {
    if (!isIncomingOffer(event, wallets)) continue;

    const expiry = pickTime(event, EXPIRY_KEYS);
    if (expiry === null) continue;

    const remaining = expiry - now;
    if (remaining <= 0 || remaining > windowMs) continue;

    // Order events carry the NFT under `asset`; sales and transfers use `nft`. Collection and
    // trait offers carry neither, because they are not about one token — those keep the slug the
    // criteria names and render without an item.
    const nft = event.asset ?? event.nft ?? {};
    const slug = nft.collection ?? event.criteria?.collection?.slug ?? "";
    const identifier = nft.identifier ?? "";

    out.push({
      kind: "offer",
      name:
        sanitize(nft.name, maxName) ||
        (identifier === "" ? "Collection offer" : `#${sanitize(identifier, 12)}`),
      collection: displayName(slug, names, maxName),
      url: collectionUrl(slug),
      amount: paymentAmount(event.payment),
      /**
       * Which of your wallets the offer is on, when there is more than one.
       *
       * The service tags every merged row with the wallet it came from, and until now nothing read
       * the tag. With nine wallets, "SAMPLE Cat #1111 · 6h" is a countdown on something you cannot
       * identify — the row tells you a decision is due and not whose it is.
       */
      wallet: sanitize(event.anchorWallet, 64),
      expiresAt: expiry,
      remaining,
      label: countdown(remaining),
    });
  }

  out.sort((a, b) => a.expiresAt - b.expiresAt);
  return out;
}

/**
 * What an offer is worth, in the currency it was actually made in.
 *
 * `payment.quantity` is in the token's smallest unit and `payment.decimals` says how many places
 * to move — the same denomination throughout, so nothing is converted. Note that this convention
 * is the *opposite* of `/balances`, where `quantity` already arrives in display units; reading one
 * endpoint's rule into the other is an error of 10^18.
 */
function paymentAmount(payment) {
  if (payment === null || typeof payment !== "object") return "";
  const whole = formatUnits(payment.quantity, payment.decimals);
  if (whole === null) return "";
  return formatMoney(whole, { symbol: payment.symbol });
}

/**
 * Incoming offers, live now. Counted separately from deadlines: an offer without a stated expiry
 * is still an offer, it just has no clock on it.
 */
function offerCount(state) {
  const wallets = walletList(state?.health);
  let count = 0;
  for (const event of eventList(state?.activity?.data)) {
    if (isIncomingOffer(event, wallets)) count++;
  }
  return count;
}

/** Events in the trailing window. The bar shows "something happened", the panel shows what. */
function activityCount(state, nowMs, settings) {
  const now = Number(nowMs) || Date.now();
  const windowMs = (Number(settings?.activityWindowHours) || 24) * 3600000;
  let count = 0;
  for (const event of eventList(state?.activity?.data)) {
    const at = pickTime(event, EVENT_TIME_KEYS);
    if (at !== null && now - at <= windowMs && now - at >= 0) count++;
  }
  return count;
}

const FLOOR_KEYS = ["floorPrice", "floor_price"];
const FLOOR_SYMBOL_KEYS = ["floorPriceSymbol", "floor_price_symbol"];

/**
 * Watched-collection floors, from `/collections`.
 *
 * This is the one reading that survives a missing PAT, which makes it the whole content of the
 * partial state. Rows the service could not fetch keep their slug and say so, rather than
 * vanishing — a collection that silently disappears reads as one the user removed.
 */
/**
 * Slug → display name, learned from `/collections`.
 *
 * A slug is an identifier and reads like one: nobody calls it "boredapeyachtclub". The service
 * returns the collection's own `name` alongside its stats, and this is the one place that mapping
 * is built, so a deadline row and a floor row cannot end up disagreeing about what to call the same
 * collection. A name is marketplace content like any other and is sanitised on the way in.
 *
 * Slugs are *not* replaced everywhere: `Model.collectionUrl` still takes the slug, and the config
 * file still names slugs, because those are the places the exact identifier is the point.
 */
function collectionNames(state, settings) {
  const out = {};
  const data = state?.collections?.data;
  if (!Array.isArray(data)) return out;
  const maxName = Number(settings?.maxNameLength) || DEFAULT_MAX_NAME;
  for (const row of data) {
    if (typeof row?.slug !== "string" || row.slug === "") continue;
    const name = sanitize(row?.name, maxName);
    if (name !== "") out[row.slug] = name;
  }
  return out;
}

/** The prettiest true name for a slug: the collection's own, else the slug itself. */
function displayName(slug, names, maxName) {
  const known = names && typeof names[slug] === "string" ? names[slug] : "";
  return known !== "" ? known : sanitize(slug, maxName);
}

function collectionRows(state, settings) {
  const data = state?.collections?.data;
  if (!Array.isArray(data)) return [];
  const maxName = Number(settings?.maxNameLength) || DEFAULT_MAX_NAME;
  const names = collectionNames(state, settings);

  return data.map((row) => {
    const slug = typeof row?.slug === "string" ? row.slug : "";
    const stats = row?.data?.total ?? row?.data ?? null;
    const floor = pickDecimal(stats, FLOOR_KEYS);
    const symbol = sanitizeSymbol(pickString(stats, FLOOR_SYMBOL_KEYS)) || "ETH";

    return {
      slug,
      name: displayName(slug, names, maxName) || "collection",
      url: collectionUrl(slug),
      floor: floor === null ? null : formatMoney(floor, { symbol }),
      error: typeof row?.error === "string" ? sanitize(row.error, 80) : null,
      stale: row?.meta?.stale === true,
    };
  });
}

function pickString(source, keys) {
  if (source === null || typeof source !== "object") return null;
  for (const key of keys) {
    if (typeof source[key] === "string" && source[key] !== "") return source[key];
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// The bar label
// -------------------------------------------------------------------------------------------

/**
 * What the bar actually renders, as data rather than as a string the QML assembles.
 *
 * Returned in pieces so the renderer can dim the stale parts independently and so this is testable
 * without a compositor. `value` is empty in every state where a number would be a claim we cannot
 * support — that is the difference between a widget that degrades and one that lies.
 */
function barLabel(state, nowMs, settings) {
  const now = Number(nowMs) || Date.now();
  const status = statusOf(state, now, settings);
  const showValue = settings?.showValue !== false;

  const base = {
    status,
    value: "",
    // Starting or unconfigured: there is no figure, so there is none to hide. The bar draws a lone
    // mark here, and the placeholder must not appear or it says the opposite of what is true.
    valueHidden: false,
    change: null,
    offers: 0,
    deadline: "",
    activity: 0,
    dim: true,
    attention: false,
  };

  if (status === STATUS.STARTING || status === STATUS.SETUP) return base;

  const next = deadlines(state, now, settings);
  const offers = offerCount(state);
  const portfolio = readPortfolio(state?.portfolio);

  return {
    status,
    value:
      showValue && portfolio.total !== null ? formatMoney(portfolio.total, { symbol: portfolio.symbol }) : "",
    /**
     * There is a total and the user has asked for it not to be shown.
     *
     * Distinct from `value === ""`, which also happens when there is nothing to show. Without the
     * distinction the bar draws the identical strip — a lone mark — for "hiding my portfolio while
     * screen-sharing" and "Anchor is not set up", and those two say opposite things about whether
     * anything is working.
     */
    valueHidden: !showValue && portfolio.total !== null,
    change: showValue ? portfolio.change : null,
    offers,
    deadline: next.length > 0 ? next[0].label : "",
    activity: activityCount(state, now, settings),
    // Offline and partial still show their numbers; they are just visibly faded, because the
    // number is real and only its provenance is in question.
    dim: status !== STATUS.READY,
    // The theme's own attention colour, and only for something with a clock running out.
    attention: next.length > 0 && next[0].remaining <= (Number(settings?.urgentHours) || 6) * 3600000,
  };
}

// -------------------------------------------------------------------------------------------
// Snapshot persistence. The bar must paint before any network call.
// -------------------------------------------------------------------------------------------

const SNAPSHOT_VERSION = 1;

/**
 * A bar is a hostile place for latency, so the widget renders from this file on the first frame
 * and only then starts talking to the service. Ages are preserved rather than reset, so a snapshot
 * restored after a reboot is honest about being old instead of looking freshly fetched.
 */
function serializeSnapshot(state) {
  const s = state ?? emptyState();
  return `${JSON.stringify(
    {
      version: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      // `health` is deliberately absent, not merely ignored on read. It names which credentials
      // exist, which is a question about now; writing it would put a stale answer on disk for
      // something that is free to ask again, and would copy the wallet address into a second file.
      portfolio: s.portfolio,
      activity: s.activity,
      collections: s.collections,
      balances: s.balances,
      updatedAt: s.updatedAt,
    },
    null,
    2,
  )}\n`;
}

/**
 * Rebuild state from a snapshot. Anything unrecognised yields a blank state rather than a throw:
 * a corrupt cache file must degrade to "no data yet", never to a shell that fails to load a widget.
 */
function parseSnapshot(raw) {
  const blank = emptyState();
  if (typeof raw !== "string" || raw.trim() === "") return blank;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    return blank;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.version !== SNAPSHOT_VERSION) return blank;

  return Object.assign(blank, {
    // Health is deliberately not restored. Which credentials exist is a question about *now*, and
    // answering it from disk would show a configured widget to someone who has since removed the
    // key. It costs one loopback request to ask again.
    health: null,
    healthError: null,
    portfolio: entryOrNull(parsed.portfolio),
    activity: entryOrNull(parsed.activity),
    collections: entryOrNull(parsed.collections),
    balances: entryOrNull(parsed.balances),
    updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
  });
}

function entryOrNull(value) {
  if (value === null || typeof value !== "object") return null;
  return {
    data: value.data ?? null,
    meta: value.meta ?? null,
    receivedAt: Number.isFinite(value.receivedAt) ? value.receivedAt : 0,
    error: typeof value.error === "string" ? value.error : null,
    status: Number.isFinite(value.status) ? value.status : 0,
  };
}

/**
 * Merge one finished read into state, without discarding what a failure cannot replace.
 *
 * `Object.assign` rather than object spread throughout this file: QML's JavaScript engine is
 * pre-ES2018 and rejects `{ ...x }` at parse time, which takes the whole widget down with a syntax
 * error rather than a runtime one. Node accepts both, so the tests would not have caught it.
 */
function applyRead(state, key, response, nowMs) {
  const s = state ?? emptyState();
  const now = Number(nowMs) || Date.now();

  if (key === "health") {
    if (response.ok) {
      return Object.assign({}, s, { health: response.data, healthError: null, reachedAt: now });
    }
    // A refusal still proves the service answered — which is why `reachedAt` moves either way.
    // 401 and 428 are answers about configuration, not failures to reach anything.
    const answered = response.status > 0;
    return Object.assign({}, s, {
      health: answered ? s.health : null,
      healthError: response.error,
      reachedAt: answered ? now : s.reachedAt,
    });
  }

  const next = Object.assign({}, s);

  if (!response.ok) {
    // Keep the previous reading. Its age keeps counting, so it fades rather than disappearing.
    const previous = s[key];
    next[key] =
      previous === null || previous === undefined
        ? { data: null, meta: null, receivedAt: 0, error: response.error, status: response.status }
        : Object.assign({}, previous, { error: response.error, status: response.status });
    return next;
  }

  next[key] = {
    data: response.data,
    meta: response.meta,
    receivedAt: now,
    error: null,
    status: response.status,
  };
  next.updatedAt = now;
  return next;
}

// -------------------------------------------------------------------------------------------

// What the bar shows. Sparse by default and widened by the person who wants more: a bar reading
// `⚓ $125K ▲1% ◆3 ◷1h 36m ·5` is six things competing in a 26px strip, and five of them are
// answers to questions nobody asked while looking at a clock. The value is the headline and the
// countdown is the only item with a deadline attached; everything else is one press away in the
// panel, and one press away from being on the bar permanently.
const DEFAULT_SETTINGS = {
  port: DEFAULT_PORT,
  timeout: 6,
  timeframe: "DAY",
  showValue: true,
  showChange: false,
  showOffers: false,
  showDeadline: true,
  showActivity: false,
  maxNameLength: DEFAULT_MAX_NAME,
  deadlineWindowHours: 48,
  activityWindowHours: 24,
  urgentHours: 6,
  staleAfter: 900,
};

const TIMEFRAMES = ["HOUR", "DAY", "WEEK", "MONTH"];

/**
 * The bar's optional items, in the order they are drawn and offered.
 *
 * One list, so the toggles in the panel and the things on the bar cannot drift apart — the same
 * argument as `optionalSummary` being derived from the steps rather than written beside them.
 */
const BAR_ITEMS = [
  { key: "showValue", label: "value" },
  { key: "showChange", label: "change" },
  { key: "showOffers", label: "offers" },
  { key: "showDeadline", label: "closing" },
  { key: "showActivity", label: "activity" },
];

/** Settings come from `shell.json`, which a person edits by hand. Every field is untrusted. */
function mergeSettings(settings) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  const input = settings ?? {};

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = input[key];
    if (value === undefined || value === null) continue;

    if (typeof DEFAULT_SETTINGS[key] === "boolean") {
      if (typeof value === "boolean") out[key] = value;
      continue;
    }
    if (typeof DEFAULT_SETTINGS[key] === "number") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[key] = n;
      continue;
    }
    if (typeof value === "string" && value !== "") out[key] = value;
  }

  if (!TIMEFRAMES.includes(out.timeframe)) out.timeframe = DEFAULT_SETTINGS.timeframe;
  return out;
}

if (typeof module !== "undefined") {
  module.exports = {
    STATUS,
    DEFAULT_SETTINGS,
    TIMEFRAMES,
    sanitize,
    sanitizeSymbol,
    shortAddress,
    isSafeSlug,
    isSafeAddress,
    collectionUrl,
    accountUrl,
    incrementDigits,
    roundDecimal,
    trimZeros,
    formatUnits,
    compactDecimal,
    groupDigits,
    formatMoney,
    padFraction,
    formatChange,
    relativeAge,
    countdown,
    toMillis,
    relativeLuminance,
    contrastRatio,
    dimAlpha,
    hexToRgb,
    parseThemeColors,
    panelSurfaces,
    ACTION,
    SERVICE_UNIT,
    configFilePath,
    actionArgv,
    parseUnitState,
    applyUnitState,
    curlArgs,
    parseResponse,
    ageSeconds,
    isStale,
    emptyState,
    credentials,
    apiKeyRejected,
    setupSteps,
    walletList,
    collectionNames,
    displayName,
    BAR_ITEMS,
    optionalSummary,
    setupProgress,
    statusOf,
    statusDetail,
    statusSummary,
    numberToDecimal,
    readPortfolio,
    addDecimals,
    sumDecimals,
    balanceRows,
    portfolioBreakdown,
    walletValues,
    missingWallets,
    provenance,
    BREAKDOWNS,
    paymentAmount,
    eventList,
    isIncomingOffer,
    deadlines,
    offerCount,
    activityCount,
    collectionRows,
    barLabel,
    serializeSnapshot,
    parseSnapshot,
    applyRead,
    mergeSettings,
  };
}

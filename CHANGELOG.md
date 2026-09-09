- ESP32 pulse firmware, **running on hardware**. The device half of the wire format is portable C99
  with no allocation and no platform calls; it is compiled and driven on every `npm test` against
  frames from the real host adapter, so the encoder is proved against a second implementation rather
  than its own decoder. An Arduino application speaks it over USB CDC to a bare ESP32-S3 N16R8, and
  a serial transport (`esp32-serial.ts`) drives it — which keeps invariant 6 by removing the socket
  rather than inverting it. Measured on the board: a 466×466 framebuffer allocates in PSRAM, a full
  frame is 23 KB on the wire and ~190 ms end to end, and an unchanged frame costs zero bytes. The
  adapter gained `setBlanked` (the contract's lock hook) and `ping`/`onPong`, which is the only
  acknowledgement the protocol has and therefore the instrument that timing is measured with. There
  is no display attached and no pulse panel exists yet; `devices/firmware/esp32/README.md` says what
  was measured, what was not, and the five bugs the hardware found.
- **One mark, at every size:** a ring, two arms, a crossbar, and a fluke curling up at the end of
  each arm — an anchor that reads as an A, on square bounds of 38×38, in three files that are the
  same drawing at three weights. A bar had broken the old six-stroke mark two ways: 10×12 in a row
  of glyphs drawing 9–11 square, and a stroke computing to 0.93 device pixels, under one, so it
  antialiased to grey. Neither is a size problem — scaling preserves aspect ratio, and a smaller
  slot makes the stroke smaller with it. Only fewer elements buy the weight, so the element count
  became the constraint and the drawing was made to fit inside it: each fluke folds into the end of
  its own arm as a curve rather than a separate stroke. Four elements, stroke 6, 1.5 device pixels
  at bar size — and the flukes cost nothing.
- A device contract (`AnchorDevice`) that panels are written against rather than a Stream Deck
  program: devices declare named slots, Anchor paints medium-neutral surfaces into them and receives
  input back. A `VirtualDevice` is the second implementation, so panels render and are reviewable
  with no hardware attached.
- Colour resolves through the live Omarchy theme, never a literal, and the font family stays
  `monospace` so a device follows `omarchy font set`. Marks are held to WCAG AA over every installed
  theme; a colour that misses the floor is corrected rather than drawn illegibly.
- **A key that is on is lit.** An active key used to be tinted 30% toward its tone with the tone
  itself drawn on top, which works on a dark theme and inverts on a light one — the accent measured
  2.25:1 against the tile it was painted on for `rose-pine`, 2.63:1 for `catppuccin-latte`, so the
  "on" key was less legible than the "off" ones beside it. A fixed blend fraction was the cause: 30%
  barely moves a near-black ground and halves the contrast of a near-white one, so one number was
  two different designs. The tile now takes its tone as a fill and the marks take whichever palette
  colour stands furthest from it, which is unmistakable at arm's length on every theme and has a
  guaranteed answer for contrast. The underline went with it; a filled key does not need one.
- **The three surfaces are real steps, derived when a theme has no opinion about depth.** Five stock
  themes set `lighter_background` to their own `background`, so a pressed key flashed at 1.02:1 —
  through the deck's diffuser, no feedback at all — and nine put the gap between keys within 1.02:1
  of the key, leaving the grid as one unbroken slab. `deriveSurfaces` takes the theme's own value
  whenever it is a genuine step off this ground and derives one from the ground when it is not,
  reversing direction where the ground has no headroom. It is the rule `widget/PulseModel.js`
  already used for the panel, so the two surfaces are one system rather than two guesses.
- **A reading is text, so tones are held to 4.5:1, not 3:1.** Every toned colour is drawn as a
  tile's value — the portfolio total, the day's P&L — and `autoSize` shrinks a long one to 13px to
  keep its last digits, which is not large text by any reading. On `solitude` the P&L came out at
  3.16:1. The floor now slides a colour's *lightness* rather than blending it toward the foreground,
  because blending is a hue change: rescuing `rose-pine`'s teal that way produced a slate purple
  that was legible and no longer Rose Pine.
- **Three themes, authored for a key as well as a screen** — `themes/harbor`, `themes/lantern` and
  `themes/driftwood`, installed to `~/.config/omarchy/themes/`. Two rules, both learned from the
  stock set: the ground is not black, because a key face at #000000 reads as a dead key on a lit
  deck and leaves the gap between keys nowhere to go; and `selection` sits well clear of the ground,
  because it is what draws a key's outline. They are the only themes on this machine whose surface
  ladder, tile edge and four tones all pass as authored, with nothing corrected at paint time.
  Driftwood is the light one, built around the fact that a mark on a light key has to go *down*:
  every coloured role is a deep, saturated version of its hue rather than a pastel.
- The contrast gate reads each `colors.toml` from disk and covers the repo's own themes and the
  user's, not only `/usr/share`. It went through `loadTokens`, which falls back to Tokyo Night for a
  name it cannot resolve — so a theme with no readable palette was measured as Tokyo Night and
  passed. It also only ever compared marks to `ground`, a surface an active key's marks never touch.
- Key faces are authored as SVG and rasterised straight to raw RGB by ImageMagick, so rendering adds
  no dependency. Glyph ink is measured through the same rasteriser and cached per font, because Nerd
  Font symbols advance 0.6em but paint up to 1.04em wide.
- A portfolio page: total, NFT and token value, P&L, and the largest holdings, read from the local
  data service. Field names come from `@opensea/api-types` rather than memory, and only holdings
  OpenSea classifies `OK` are shown — an unfiltered list on an airdropped-at wallet is a list of
  scams. An absent reading renders as an em dash, never a zero. The strip carries the figures' age
  and staleness, and a dial scrubs the window through the four timeframes the endpoint accepts.
- The device contract gains `list` and `detail` surfaces, committed-text input, screen slots, and
  optional blanking. Both were asked for independently by the ESP32 and Cardputer designs, which is
  what made them contract changes rather than adapter concerns: the panel is the only thing that
  turns config plus state into surfaces, so an adapter-local list would have to fetch its own data.
  The same page now composes as a key grid or as rows, and a test asserts both carry identical
  readings. Text narrows what is on screen and is never dispatched. A display blanks on logind's
  `LockedHint`, clearing the keys as well as the backlight.
- No device action can sign, spend or approve. The vocabulary has no such verb and a test asserts it.
- **The Cardputer has a device end.** Anchor now paints an M5Stack Cardputer over USB CDC, and the
  firmware is an app in flint (`ryanio/cardputer`) rather than a second firmware in this repo: a
  view drawing the surfaces the adapter sends, in the palette of the live Omarchy theme. Nothing on
  the unit fetches anything, holds a credential or can ask for an action; the desktop composes every
  frame, because the data service binds loopback and no device should hold a key to it. Typing on
  the keyboard opens a filter that narrows rows the host already has, and no keystroke while it is
  open reaches the panel at all. Verified in flint's simulator, which renders the real view code at
  the real 240x135; **no Cardputer has run it yet.**
- `anchor-devices --cardputer` drives one, and waits for the device's `hello` before painting when
  the port was guessed: every ESP32-S3 with native USB enumerates through the same Espressif
  descriptor, so a matching port name identifies a chip family and not a device.
- Two pages ship: Omarchy desktop control (workspaces, theme, night light, screenshot, volume and
  workspace dials) and an Anchor page showing service reachability and whether a wallet is
  configured.

**The data service** — the foundation everything else reads from, so there is one cache, one
outbound rate limit, and one place where freshness is tracked.

- Read-only by construction: only `GET` and `HEAD` are routed inbound, and the OpenSea client's
  `post()` and `request()` throw, so every SDK write path fails at the transport rather than by
  convention.
- Cache-first, backed by `node:sqlite`, with an explicit freshness envelope on every response and a
  stale-on-failure fallback. Staleness is millisecond-based and treats a backwards clock as stale.
- Built on [`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-js) and `@opensea/api-types`.
  Every call goes through the SDK and every response is typed from the generated OpenAPI types.
- Loopback-only, and it requires a loopback `Host` header — binding to `127.0.0.1` stops the network
  reaching it but not a browser whose DNS rebinds to it.
- When no wallet is configured and the stored PAT is opaque, it is exchanged at
  `/api/v2/auth/tokens/exchange` and the resulting JWT's `wallet` and `linked_wallets` claims supply
  the wallet list, filtered to the configured chains. One network call, only on the path where
  nothing else supplied a wallet, and every failure leaves the service as it was.
- When no wallet is configured, the address is derived from the wallet PAT's `wallet` claim via
  `@opensea/sdk`'s `extractWalletAddress` — a local decode, so it needs no scope and cannot 401. A
  configured wallet always wins; a token that is opaque, carries no wallet claim, or names an
  address for a chain that is not configured contributes nothing and says which. `/health` reports
  `walletSource`, because a wallet nobody typed in should name its source rather than just appear.
  The SDK's warning that `sub` is an account identifier and never a wallet is pinned by a test.
- Credentials live in the OS keyring, never in config, argv or logs. Errors are rebuilt from a status
  code, so a remote response body can never carry a credential back out.

**`@opensea/sdk` 12.4.1 and `@opensea/api-types` 0.9.3.** `PortfolioArgs.chains`,
`GetTokensArgs.chains` and an array-valued `GetEventsArgs.eventType` all landed upstream, so three
casts that existed only because the arg types were narrower than the API are gone and the calls say
what they mean. `chains` on the portfolio call is also the parameter that makes the endpoint's
deterministic 500 go away.

**Both marketplaces.** OpenSea is NFTs *and* fungible tokens, and Anchor treats them as different
products rather than one with a quantity field. The token half covers portfolio value, balances,
trending and top tokens, individual tokens and price history.
[docs/tokens.md](docs/tokens.md) sets out the five places they genuinely diverge — including
slippage, which is a spend control: a $500 per-transaction cap means nothing if a swap executes at
90% price impact.

**Chains are configuration, and Solana is native.** `chains` is a validated list, so a Solana-only
setup is as ordinary as an EVM one. The list is derived from the SDK at runtime rather than copied,
with a compile-time check that fails if the SDK enum and the generated types ever disagree. Address
validation is chain-aware — EVM is `0x` plus 40 hex, Solana is base58 decoding to exactly 32 bytes —
and runs at config load, so a mismatch is a startup error naming the field rather than a 400 hours
later. [docs/chains.md](docs/chains.md) covers where chains actually differ.

**One credential, and a guard on it.** Every read Anchor makes needs the OpenSea API key and
nothing else. An earlier version of this file claimed account-scoped reads also required a wallet
JWT; that was wrong, and the story is in the [build diary](https://anchor.ryanio.com). A wallet
token is still supported — `anchor-service --set-pat` stores a personal access token, exchanged for
a JWT and refreshed before expiry — because the spec declares `WalletAuth` on fifty paths Anchor
does not call yet, and writing will need it. It gates nothing.

Credentials are validated on the way in. A credential is one opaque token, and a value carrying
whitespace or control characters is refused rather than stored, because a reader that accepts
"whatever line arrived" will cheerfully store a shell command — which is exactly what happened.

**Policy-bound execution** (preview — see Known limitations). An `Executor` interface splitting
`request → simulate → decide → submit`, so holding one stage does not grant the next. Approvals are
unforgeable two ways: an `ApprovedAction` carries a property keyed by a non-exported `unique symbol`,
and because a cast defeats types, the brand is backed by a module-private `WeakSet` that
`Signer.submit` checks. The witness has no runtime representation, so a spread, `structuredClone` or
JSON round-trip fails closed. Actions that delegate standing authority are excluded from the
delegable action type altogether — they cannot be configured into an allowlist by a typo or a future
refactor.

**The executor speaks both chains.** `Address` is a union of two nominally distinct branded types,
`EvmAddress | SolanaAddress`, parsed rather than pattern-matched: EVM hex is lowercased because
EIP-55 casing is a checksum, and base58 is preserved verbatim because its casing is *the value*.
Every allowlist entry is a `(chain, address)` pair, so an entry for one chain never matches an
address on another — the same twenty hex bytes name a different contract on every EVM chain, and
`CREATE2` puts chosen code at a chosen address on a chain nobody configured.

`setApprovalForAll` turned out to have several Solana counterparts rather than none. The membership
test is written down — an action that *moves no value*, *grants an authority outliving the
transaction*, and *needs a revocation nobody can guarantee* — and it admits the SPL `Approve`
delegate and `SetAuthority`, which does not bound what a delegate may spend but hands over the
account. It also admits the System Program's `Assign`, the widest member of the class and the one an
SPL-only reading misses: a wallet account is system-owned, an account's owner program may debit its
lamports with no signature, so one `Assign` hands over the entire native balance having moved
nothing. Closing an account is deliberately outside the class (it moves value, so the withdrawal
allowlist covers it), and arbitrary program invocation is not an action kind at all: an
`ActionRequest` carries intent and has no member that can hold instructions or bytes.

A dependency-free guard parses legacy and v0 Solana transactions and refuses a delegation, an
unallowlisted program, or an unrecognised instruction — soundly *in the presence of address lookup
tables*, because it reads program ids and instruction data rather than resolved accounts. It is
explicit that it cannot check where value goes when operands resolve through a table: a refusal
filter, never a simulation.

Being on the program allowlist means *permission to be inspected*, not permission to run. Four of
the six allowlisted programs have their instructions classified, across three discriminant
encodings in one file: SPL Token's tag is one byte, the System Program's is a four-byte
little-endian `u32`, and the Compute Budget program's is a one-byte borsh tag. Only Memo and the
Associated Token program are allowed unconditionally. The Compute Budget program is
included because it is not inert: `SetComputeUnitPrice` names a price per compute unit, and at the
maximum unit limit it commits the account's entire native balance to a validator tip. That is a
spend no cap can see, because a priority fee produces no asset delta and appears in no simulation,
so it is refused here against a ceiling of 0.01 SOL rather than upstream where the number does not
exist. Unusually for this module the check is exact: both operands are inline literals, so no
lookup table can move the answer.

A Privy backend is the first authority where enforcement lives outside Anchor's process: the key is
in Privy's enclave, and Anchor audits the remote policy at startup and refuses to run when its local
limits claim more than that policy grants. Caps charge gross outflow, because netting would permit
wash-trade drains, and budget is reserved at approval rather than settlement. The value ladder —
$100 to $100k+, each tier earned by a clean incident record — is in
[docs/autonomy.md](docs/autonomy.md).

**The Quickshell bar widget** — roadmap step 2. Portfolio value, incoming offers, closing
deadlines and an activity count, in the Omarchy top bar, read from the local service on loopback.

- **It never blocks the bar.** Every fetch is a detached `curl`; the last reading is restored from a
  snapshot on disk before any of them start, so the bar has content on its first frame. This runs
  inside the single process that draws the whole desktop.
- **Every degraded state is a designed state.** Service down, no API key, no wallet, offline — each
  renders as a calm dimmed mark and a panel saying what is missing and offering the button that
  fixes it, never as an error. A red box on a fresh install is a bad first impression.
- **The panel opens on a few things.** Hero, the number and where it came from, what is closing,
  one row of controls. The breakdown, the floor list, the raw command behind each setup step and
  the bar-item toggles are behind a `details` disclosure — deferred, not deleted.
- **The bar starts sparse and is widened by the person who wants more.** The mark, the value and
  the countdown to the next offer that closes. The change, the offer count and the activity count
  are off by default and switch on from the panel's details view or with `omarchy bar set`.
- **The number says where it came from**: which wallets, and how old, in one line under the total.
  A total is a claim about specific addresses at a specific moment, and a panel that prints the
  figure without either is asking to be believed rather than read.
- **A portfolio breakdown**, behind the disclosure, as a labelled split bar rather than a pie —
  part-to-whole is a stacked bar, and a pie of two slices is the canonical way to make a ratio
  harder to read than the sentence it replaced. Three views: `type` (the whole portfolio, from
  `nftValueUsd`/`tokenValueUsd`), `assets` and `chains` (from `/balances`). The last two are the
  *token* half and say so, with their own total: NFT value is not broken down by chain or by asset
  by any endpoint, and distributing it across token rows would print a number that is not true.
- **USD always carries two decimal places.** `$125,430.5` reached the bar. The rule is keyed on the
  denomination and applies only to it — ETH at eight places must not become `1.50000000` — and to
  amounts rather than magnitudes, so `$125K` is not padded and `$11.10` is.
- **Collections are called by their name.** `/collections` now returns each collection's display
  name alongside its stats, and the panel shows "Bored Ape Yacht Club" where it showed
  `boredapeyachtclub`. Slugs stay where the exact identifier is the point: links, and the config.
- **Every configured wallet is watched.** `wallets` is a list in the config and `wallet: "0x…"` is
  read as a one-element one. Anchor still cannot *discover* a person's wallets — it holds no wallet
  credential and no endpoint maps a human to their addresses — so the setup step is widened rather
  than deleted, and the no-wallets state is unchanged.
- **Depth comes from the active Omarchy theme.** The panel draws on three surfaces — ground, raised
  and sunken — read from the theme's own `colors.toml` (`lighter_background`, `dark_background`,
  `selection`), three keys the shell's `Color` singleton does not expose. Where a theme's value is
  not a usable step off the popup's actual ground, one is derived from it. Checked against all 22
  stock themes, including `white` and `vantablack`, which have no headroom in one direction.
- **A setup step does the thing rather than describing it.** Step 1 is a **Start Anchor** button
  running `systemctl --user start anchor-service` (with **and at login** for `enable --now`); step 2
  opens a terminal on the API-key prompt; step 3 opens the config file in Omarchy's editor. The raw
  commands moved behind the `details` disclosure.
- **Staleness is shown, not hidden**, using the service's own `meta.ageSeconds` so a reading keeps
  ageing honestly across a reboot.
- **Setup is three steps, not a wall.** Completed steps leave the queue and a segmented bar keeps the
  record; one step is current and only it offers an action; the optional step collapses behind a pill
  you can press. Each step says what it gets you rather than what it configures. The "Set up
  Anchor · step 2 of 3" header was removed: between it, the counter, the segments and the numbered
  discs, the panel was saying one fact four ways.
- **Every panel state can be looked at.** The panel has fifteen — starting, four setup steps,
  offline cold and warm, stale, a rejected key, a collection that failed, and the working ones — and
  a live machine is in exactly one of them, so its error screens had never been reviewed by anyone.
  `PanelContent.qml` renders from a single reading and takes no action itself, so `widget/gallery/`
  mounts it against a fixture per state and photographs all fifteen with no service, bar or desktop.
- **One mark, at every size.** A ring, two branches off it, a crossbar — square bounds of 36×36, and
  three files that are the same drawing at three weights. It briefly was two marks, a whole anchor
  plus a cropped variant for the bar, and two marks for one product is a cost with no payer: the bar
  showed one thing and the site showed another. A bar broke the whole anchor two ways — 10×12 in a
  row of glyphs drawing 9–11 square, and a stroke computing to 0.93 device pixels, under one, so it
  antialiased to grey. Neither is a size problem: scaling preserves aspect ratio, and a smaller slot
  makes the stroke smaller with it. Only fewer elements buy the weight, so six became four and the
  stroke became 1.57 pixels. What it costs is the anchor read at large sizes, which was the trade —
  a mark that only works when it is large is not a mark.
- **The bar's open-panel underline tracks what the widget paints.** `Bar.qml` looks for an
  `openPanelIndicatorWidth` on a module and otherwise falls back to 55% of the slot, a figure
  calibrated for a text label in a padded slot. Measured on the running bar: a 172px slot drew a
  96px underline against 154px of content.
- **The scrollbar has its own lane.** An attached `ScrollBar.vertical` reserves nothing — measured,
  10px wide at `flick.width - 10` — so it painted over the right edge of the panel's cards the
  moment a flick made it appear. The content column is inset by that width on both sides,
  unconditionally, so the bar has somewhere to be and nothing moves when a list gets longer.
- **The bar's hover tooltip is one line.** The shell owns a single shared tooltip whose label is
  hardcoded centre-aligned with one weight and no per-module override, so a four-line paragraph
  handed to it read as a centred block with nothing leading. The alignment was never the widget's
  to set; the paragraph was.
- **Something leads in every row.** The value is bold, the name is regular, the sub-line is dimmed.
  A list where the label and the value are the same weight and colour reads as a wall.
- **The step marker is aligned by measurement.** The numeral sits on the step title's own baseline
  and the disc is centred on the numeral's ink, both derived from `FontMetrics`/`TextMetrics` at
  runtime. It was a fixed 1px top margin against a metric-derived label, which put the disc 2.1px
  below the title's cap-height centre and grew worse as `[font] base-size` rose.
- **A stored credential is not a working one.** A 401 on any read sends the API-key step back to
  current and says the key is being rejected, rather than ticking it because `/health` says a string
  exists.
- Marketplace names are sanitised — bidi overrides, zero-width padding, combining-mark runs and
  control characters — and rendered as plain text. Money stays a decimal string, rounded digit by
  digit; no denomination is ever converted, because there is no exchange rate in the widget.
- Read-only: no credential of its own, loopback only, and clicking a row opens a browser.
- **The panel passes an identifier, never a command.** `Model.actionArgv` owns a closed table of
  literal argv arrays and returns null for anything else, so nothing that arrives over the network
  or out of `shell.json` has a path to something that executes. The one non-literal value — the
  config file's path — is built from `$HOME`/`$XDG_CONFIG_HOME` and rejected if it is relative,
  contains `..`, or carries a control character. No credential passes through the widget: the API
  key is typed into a terminal that writes it straight to the keyring.

**A component layer above the tokens** — `theme/components.css`, with `theme/README.md` documenting
each piece and when to use it. Pills, a step primitive, segmented progress, buttons in two weights,
list rows, and generalised surfaces (`.card`, `.card--raised`, `.well`, `.lift`), so the site, the
widget and the standalone pages compose from one vocabulary instead of each inventing its own.
Variants choose weight, never hue, which is what makes "one accent per view" enforceable rather than
aspirational.

**Design principles, written down** — a short section at the top of `theme/README.md` that governs
every surface Anchor draws: open on a few things, reassurance is not information, defer rather than
delete but be willing to delete, a step does the thing rather than describing it, depth instead of
dividers, and never a colour at a call site. It also records where a future NFT-driven theme plugs
in — `tokens.css` for the web, the Omarchy theme's `colors.toml` for the widget — and there is no
third seam, because no colour the widget draws is a literal.

**`widget/SplitBar.qml`** — a part-to-whole split as a bar plus one labelled row per part, on a
sequential single-hue scale taken from the live theme. Documented in `theme/README.md` as a house
rule: never a pie, never a legend that is the only way to read the chart, and text never wears a
segment's colour.

**`packaging/anchor-service.service`** — the data service as a systemd *user* unit, so starting it
is a button in the bar rather than a command to copy. Installed to `/usr/lib/systemd/user/` by the
PKGBUILD. **`/usr/bin/anchor-service`, which the unit's `ExecStart` names, does not exist yet** — it
needs to be a wrapper around the packaged service and its `node_modules`, and until it is, the unit
must be written against a checkout (see `service/README.md`). The widget probes the unit rather than
assuming it, so a machine without one shows the command exactly as before.

**The site, the brand, and the tooling.**

- anchor.ryanio.com: build diary, changelog and `llms.txt`, on a deep-water palette with shared
  tokens in `theme/tokens.css` reused across the project rather than redefined.
- One mark that reads as an **A** and as an anchor's head, stroke-based on `currentColor`, square,
  legible at 11px — three files that are the same drawing at three weights.
- `scripts/check-contrast.ts` computes WCAG ratios from the tokens and fails CI — all 38 text,
  accent and component pairs clear AA in both themes, so a colour that looks good but is unreadable
  cannot land. The widget's colours cannot be reached from there, because they are the user's live
  theme; `widget/test/model.test.mjs` runs the same arithmetic over the stock Omarchy palettes and
  is in CI too.
- `scripts/check-versions.ts` enforces the Node floor across `.node-version`, CI and the PKGBUILD,
  and requires GitHub Actions to be pinned to commit SHAs rather than mutable tags.
- Biome as the single formatter and linter — never ESLint or Prettier.
- `scripts/generate-asset.ts` for images and video from xAI, key in the keyring, zero dependencies.
- [docs/upstream.md](docs/upstream.md) — every workaround that exists only because of an upstream
  gap, and what to delete when each is fixed.

### Changed
- **`@opensea/sdk` 12.1.1 and `@opensea/api-types` 0.9.2.** Three findings Anchor reported upstream
  are fixed in this release. Path parameters are encoded by the SDK, so Anchor stopped encoding them
  — doing both double-encodes, which its own traversal test caught. `segment()` remains, and still
  refuses `.` and `..`, because encoding never handled those and the URL parser strips escapes before
  removing dot segments.
- **A retry ladder.** Every SDK error now carries a `statusCode`, which makes it possible to tell a
  retryable failure from a permanent one for the first time. 502/503/504 and status-less transport
  errors are retried twice with jittered backoff, outside the shared rate limiter so a sleeping
  request cannot hold a slot. 500 is excluded deliberately: `/account/{address}/portfolio` returns a
  deterministic one, and retrying it only delays the stale-cache fallback.

### Known limitations

- **The wallet-token exchange has never been run end to end.** Its request and response shapes are
  read from `@opensea/sdk`'s source rather than from a successful call. We now hold a scoped token,
  but no route Anchor calls needs one, so nothing exercises the path.
- **`/account/{address}/portfolio` returns 500 upstream** for a large account with no query
  parameters, and 200 for that same account with any parameter. Reported to OpenSea; see
  [docs/upstream.md](docs/upstream.md).
- **Privy's policy engine cannot express Anchor's cumulative caps.** Its spend-limit primitive tops
  out at a 72-hour rolling window and does not observe `eth_sendTransaction` at all, so the rolling
  24h and 7d caps in [docs/autonomy.md](docs/autonomy.md) are enforced *only* by the in-process
  mirror. The per-transaction cap, the contract and withdrawal allowlists, and the delegation
  refusal are enforced by Privy and survive a compromised desktop. The rolling totals do not.
- **Privy's Solana policy engine is materially weaker than its EVM one**, and this is the finding to
  read twice. It has no condition that can name `Approve`, `ApproveChecked` or `SetAuthority` — its
  token decoder covers six other instructions — so there is no Solana equivalent of the
  `ethereum_calldata` + `function_name` condition that refuses `setApprovalForAll` by name. The only
  remote control is an ALLOW rule that positively lists the instructions Anchor sends, letting
  default-deny refuse the rest; omit that one condition and the control disappears with no error
  anywhere, so Anchor's startup audit refuses to run against a policy missing it. Solana also has
  *no* aggregation primitive at all, so both cumulative caps are local-only there, and Privy reject
  outright any transaction whose conditions need an address loaded from an address lookup table.
  Starkest of all: **there is no Compute Budget condition source**, so a Privy policy can permit the
  program and then say nothing whatever about the priority fee it names. The other gaps are controls
  weaker than their EVM counterparts; this one has no remote expression at all, and the local ceiling
  is the only thing standing there. The startup audit states it every time rather than refusing,
  because there is no policy change that would fix it.
- **Anchor cannot build a Solana transaction.** Compiling an SPL transfer needs associated token
  account derivation — ed25519 on-curve arithmetic — and a live blockhash. The builder refuses and
  explains itself; the policy, guard and signer around it are complete and tested. Closing this needs
  either a compiled transaction from OpenSea's `/swap/execute` or a runtime dependency, which is a
  human's decision.
- **`ActionRequest` does not model a signed Seaport order**, so marketplace actions are approved by
  policy and then refused by the transaction builder. ERC-721 withdrawals work end to end. Seaport is
  EVM-only upstream, so there is no Solana version of this gap.
- **No package yet.** `packaging/PKGBUILD` is a skeleton targeting the `[omarchy]` repository; the
  install path is not yet `omarchy pkg install anchor`.

[Unreleased]: https://github.com/ryanio/anchor/compare/main...HEAD

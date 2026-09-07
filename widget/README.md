# widget

Anchor's Quickshell bar widget. **Step 2 of the roadmap.**

Portfolio value, incoming offers, closing deadlines and an activity count, read from the local data
service on loopback. Clicking a row opens its page on OpenSea.

**Read-only, all the way down.** It holds no credential, talks to one loopback port, and the service
it reads refuses every non-GET before routing. There is no code path from this widget to a signature.

---

## Install

The widget is an Omarchy plugin. It must sit exactly one level under the plugin directory, in a
folder named for its manifest `id`:

```bash
mkdir -p ~/.config/omarchy/plugins
cp -r widget ~/.config/omarchy/plugins/anchor.pulse

omarchy plugin validate ~/.config/omarchy/plugins/anchor.pulse
omarchy plugin enable anchor.pulse --section right
omarchy bar put anchor.pulse --after omarchy.tray
```

Check it loaded:

```bash
omarchy-shell shell listPlugins        # anchor.pulse should be enabled: true
quickshell log -p /usr/share/omarchy/shell   # QML errors land here
```

### Developing against a checkout

A symlink works at runtime and is far more convenient than copying:

```bash
ln -sfn "$PWD/widget" ~/.config/omarchy/plugins/anchor.pulse
```

Two caveats, both learned the hard way:

- **`omarchy plugin validate` refuses symlinks.** Validate the real directory instead.
- **Edits will not hot-reload.** The shell watches the plugin directory with `inotifywait -r`, which
  does not follow symlinks, so nothing inside your checkout is ever seen. `rescanPlugins` does not
  help either — it reloads the registry, not the compiled QML. Restart the shell:

  ```bash
  omarchy restart shell     # NOT `omarchy refresh shell`, which resets shell.json to defaults
  ```

## Configure

Settings live inline on the bar layout entry in `~/.config/omarchy/shell.json`. There is no separate
config file and no merge layer — the object the widget receives is that entry minus `id`.

```bash
omarchy bar set anchor.pulse port 8787
omarchy bar set anchor.pulse showValue false
```

| Key | Default | What it does |
|---|---|---|
| `port` | `8787` | Loopback port of the data service. Must match `port` in `~/.config/anchor/config.json`. |
| `timeframe` | `DAY` | Window the percentage change is measured across: `HOUR`, `DAY`, `WEEK`, `MONTH`. |
| `showValue` | `true` | Show the portfolio number on the bar. Turn off while screen sharing — offers and deadlines still show, and the value stays in the panel. |
| `deadlineWindowHours` | `48` | Only count down offers closing within this many hours. Further out is not news. |
| `urgentHours` | `6` | A countdown inside this window is drawn in the theme's attention colour. |
| `activityWindowHours` | `24` | Window the activity count on the bar is measured over. |
| `staleAfter` | `900` | Seconds after which a reading is called stale, even if the service has not said so. |
| `maxNameLength` | `28` | Characters of a collection or item name to show before truncating. |
| `timeout` | `6` | Seconds `curl` waits for the service before the read is treated as a failure. |

The manifest also carries a `defaults` block, but **the shell does not apply it** — it is stored as
registry metadata and never merged into `settings`. The defaults above are applied by
`Model.mergeSettings`, which is also where every value is validated, because this is a file people
hand-edit.

## Using it

| Input | Does |
|---|---|
| Left click | Open or close the panel |
| Right click | Toggle the portfolio value on the bar |
| Middle click | Refresh every read now |
| `r` in the panel | Refresh |
| `v` in the panel | Toggle the value |
| `Esc` | Close |

Over IPC, which is useful from a hook after the service restarts:

```bash
omarchy-shell anchor.pulse refresh
omarchy-shell anchor.pulse toggle
```

## What each state means

None of these is an error. All but the last are normal on a fresh install, and the widget stays a
calm dimmed mark rather than a red box.

| Bar shows | State | Meaning | Panel offers |
|---|---|---|---|
| Dimmed mark, no numbers | `starting` | Nothing read yet, and no snapshot on disk. | "reading…" |
| Dimmed mark, last number | `offline` | The service did not answer. The previous reading stays, labelled with its age. | The age of what you are looking at, and the command to start the service |
| Dimmed mark | `setup` | The service answered, but Anchor is not configured far enough to show anything. | The setup sequence — see below |
| Number, dimmed | `stale` | Configured and working; something on screen has outlived its TTL. | "stale, *n* old — retrying" |
| Number, full strength | `ready` | Everything is current. | Portfolio, what is closing, floors |

**Staleness is always shown, never hidden.** Every number carries the age of the data behind it,
taken from the service's own `meta.ageSeconds` so it keeps counting across a reboot. A stale floor
price displayed as current is a bug, not a rounding of the truth.

**The bar never blocks.** Every fetch is a detached `curl` process, and the last reading is restored
from `~/.local/state/anchor/widget-cache.json` before any of them start — so the bar has content on
its first frame. This widget runs inside the single process that draws the whole desktop; a
synchronous request here would freeze the bar, the notifications and every panel at once.

### The setup sequence

Three required steps, one optional. Completed steps **leave** the list; the segmented bar above them
keeps the record, and the header says which step you are on.

1. **Start the data service** — everything Anchor shows is read through it, on loopback.
2. **Add your OpenSea API key** — the only credential Anchor needs.
3. **Say which wallet to follow** — Anchor watches it, and never holds its keys.

Optional, collapsed behind a pill you can press: **watch a few collections**, for floor prices.

Only the current step shows its command, because offering a command for a step that cannot succeed
yet is an invitation to run it and watch it fail.

There is deliberately **no wallet-PAT step**. Anchor used to ask for one; re-measured with a key that
actually authenticates, every route this service calls needs the API key and nothing else. See the
header of `service/src/auth.ts`.

If the API key is *stored* but OpenSea is *rejecting* it — a 401 on any data read — step 2 comes back
as the current step and says so, rather than ticking and leaving you to wonder why a fully
configured Anchor shows nothing. `/health` can only report that a credential exists; presence and
function are different claims. `anchor-service --check-credentials` settles it.

## Design notes

- **The mark is the identity, not the hue.** Every colour is the user's own Omarchy theme, read
  through `bar.barForeground` and `Color.*`. A widget that painted itself ocean-cyan on a Rose Pine
  desktop would look like a bug.
- **Direction is an arrow, never a colour.** Red and green fight every desktop theme and vanish
  entirely for a red-green colour-blind reader.
- **One accent per view.** The theme's attention colour appears in exactly one place: a countdown
  whose window is actually closing. A bar that is always urgent is a bar nobody reads.
- **Contrast is enforced at runtime.** `scripts/check-contrast.ts` gates the project's own tokens,
  but it cannot help here — these colours belong to whichever theme is applied right now, and a fade
  that reads fine on Tokyo Night is invisible on Catppuccin Latte. `Model.dimAlpha` runs the same
  WCAG arithmetic on the live values and refuses to fade further than the theme can carry.
- **`prefers-reduced-motion` is honoured** by reading the desktop's `enable-animations` setting once
  at startup. If it cannot be read, motion stays on — the status quo rather than a guess.
- **Marketplace text is hostile.** Collection and token names go through `Model.sanitize` — bidi
  overrides, zero-width padding, stacked combining marks and control characters removed, truncated by
  code point — and every label renders as `Text.PlainText`. Neither defence is load-bearing alone.
- **Money is exact and never converted.** Amounts stay decimal strings and are rounded digit by digit
  with a carry; there is no exchange rate anywhere in the model. The bar shows `$3.36M`, the tooltip
  and panel show what that was rounded from. Floors stay in ETH because that is the denomination they
  arrived in.

## Tests

The logic lives in `PulseModel.js` with no QML imports, so all of it runs under `node --test`:

```bash
npm test --prefix widget
```

The QML is a thin renderer over that file. What the tests cannot cover is whether it *renders* —
for that, install it and look at the bar.

import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "PulseModel.js" as Model

// Anchor's bar widget: portfolio pulse, incoming offers, closing deadlines, activity count.
//
// Read-only, all the way down. It talks to one loopback port, it has no credential of its own, and
// the service it reads refuses every non-GET before routing — so there is no code path from this
// widget to a signature. Clicking a row opens a page in a browser; nothing here can spend anything.
//
// Two properties govern the whole design:
//
//   **It paints before it fetches.** The last reading is restored from a snapshot on disk during
//   `Component.onCompleted`, so the bar has content on its first frame. Every network call is a
//   detached process. Nothing in this file blocks, because this file runs inside the process that
//   draws the entire desktop.
//
//   **Every degraded state is a designed state.** The service can be down, the API key absent or
//   rejected, the network gone, and no wallet configured at all — four conditions that are all
//   *normal* on a fresh install. None of them renders as an error: the widget stays a calm dimmed
//   mark with a panel that says what is missing and offers the button that fixes it.
//
// The panel spawns processes, which in a bar widget deserves a hard look. It passes an *identifier*
// to `Model.actionArgv`, never a command: every argv is literal, the table is closed, and an id
// that is not in it runs nothing. See the "Actions the panel can take" section of `PulseModel.js`
// for what those commands can and cannot do, and for why no credential ever passes through here.
Panel {
  id: root

  moduleName: "anchor.pulse"
  ipcTarget: "anchor.pulse"
  // One IPC target may have exactly one handler. The base `Panel` registers `open`/`close`/`toggle`
  // on `ipcTarget`; taking it over here means `refresh` can live alongside them instead of the two
  // handlers racing and the shell logging that one of them will never be called.
  manageIpc: false

  // ------------------------------------------------------------------ configuration and state

  readonly property var config: Model.mergeSettings(settings)
  property var state: Model.emptyState()

  /** Ticked so countdowns move. See the timer below for why it is not always once a second. */
  property real nowMs: Date.now()

  readonly property var label: Model.barLabel(state, nowMs, config)
  readonly property string status: label.status
  readonly property var deadlines: Model.deadlines(state, nowMs, config)
  readonly property var portfolio: Model.readPortfolio(state.portfolio)
  readonly property var collections: Model.collectionRows(state, config)
  readonly property var progress: Model.setupProgress(state)

  /** Which breakdown the details view is showing. Never affects the default view. */
  property string breakdown: "type"
  readonly property var split: Model.portfolioBreakdown(root.state, root.config, root.breakdown)

  /**
   * Where the number came from: which wallets, and how fresh.
   *
   * Not behind the disclosure, and not a debug line. A total is a claim about specific addresses at
   * a specific moment, and a panel that prints the figure without either is asking to be believed
   * rather than read. This project has already had one afternoon of a plausible number being taken
   * for a true one.
   */
  readonly property string provenance: Model.provenance(root.state, root.nowMs, root.config)
  readonly property bool needsSetup: status === Model.STATUS.SETUP

  /** The step being worked on, so the keyboard can reach the same button the pointer can. */
  readonly property var currentStep: {
    const steps = root.progress.required
    for (let i = 0; i < steps.length; i++) if (steps[i].state === "current") return steps[i]
    return null
  }

  /**
   * Whether the optional steps are expanded.
   *
   * Bound rather than fixed, so it defaults open exactly when the optional steps *are* the point —
   * once the required path is done and they are all that is left. While setup is unfinished they
   * stay collapsed, which is what keeps the required path short. Clicking the pill breaks the
   * binding, which is the intended QML idiom here: after that the choice is the user's.
   */
  property bool optionalOpen: root.progress.complete

  /**
   * Whether the second view is showing.
   *
   * Closed on open, always: the default panel is a hero, a number, what is closing, and one row of
   * controls. Everything diagnostic — the NFT/token split, the age of a *current* reading, the
   * floor list, the raw command behind each setup step, the read-only note — lives behind this and
   * is one press away. Deferred, not deleted; see "Design principles" in `theme/README.md`.
   */
  property bool detailsOpen: false

  /**
   * Honour `prefers-reduced-motion`.
   *
   * Neither Qt nor Quickshell surfaces it, so the GNOME/portal setting is read once at startup —
   * it is what the XDG desktop portal exposes as the reduced-motion signal on this stack. If
   * `gsettings` is missing or fails, motion stays on, which is the status quo rather than a guess.
   */
  property bool animate: true

  Process {
    id: motionPref
    command: ["gsettings", "get", "org.gnome.desktop.interface", "enable-animations"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        const value = String(text || "").trim()
        if (value === "false") root.animate = false
      }
    }
  }

  readonly property var wallets: Model.walletList(state.health)

  /**
   * The hero's trailing pill. One wallet gets its short address; several get a count, because six
   * truncated hex strings is not information, it is a wall.
   */
  readonly property string walletShort: root.wallets.length === 0
    ? ""
    : root.wallets.length === 1
      ? Model.shortAddress(root.wallets[0])
      : root.wallets.length + " wallets"

  // ------------------------------------------------------------------------------ theme colours
  //
  // Nothing here is a hardcoded palette. The mark takes `currentColor` the way the brand asks, and
  // every other colour is the user's own Omarchy theme: `foreground` for text, `urgent` for the one
  // thing that has a clock running out. Anchor's identity in the bar is the shape, not the hue —
  // a widget that painted itself ocean-cyan on a Rose Pine desktop would look like a bug.

  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  /**
   * The ground the bar text actually sits on, for the contrast arithmetic below.
   *
   * A transparent bar has no ground of its own — what is behind it is the wallpaper, which we
   * cannot measure. The theme's own background is the honest stand-in, and it is what the theme
   * author balanced the foreground against in the first place.
   */
  readonly property color ground: {
    const barBg = bar ? bar.background : Color.background
    return barBg.a >= 0.9 ? barBg : Color.background
  }

  /**
   * How far a faded element may fade on *this* theme.
   *
   * `scripts/check-contrast.ts` gates the project's own tokens, but it cannot help here: these
   * colours belong to whichever Omarchy theme is applied right now, and a fade that reads fine on
   * Tokyo Night is invisible on Catppuccin Latte. So the same WCAG arithmetic runs against the live
   * colours and the fade is clamped to what the theme can carry — including refusing to fade at all.
   */
  readonly property real dimOpacity: Model.dimAlpha(foreground, ground, 0.55, 3)

  readonly property color dim: Qt.rgba(foreground.r, foreground.g, foreground.b, dimOpacity)
  readonly property color panelForeground: bar ? bar.foreground : Color.foreground
  readonly property color panelDim: Qt.darker(panelForeground, 1.5)
  /** The popup's own surface, which is what panel text is measured against — not the bar's. */
  readonly property color panelGround: Color.popups.background

  /**
   * Depth, taken from the theme rather than invented.
   *
   * The panel used to paint its ground, its rows and its wells the same colour, which is what made
   * it read flat. `Color` cannot help — it keeps five values out of `colors.toml` and none of them
   * is a surface — so `OmarchyPalette` reads the same file for the layers the theme already
   * defines and `Model.panelSurfaces` decides, per theme, whether each one is a usable step off
   * *this* ground or has to be derived from it. Checked against all 22 stock themes.
   */
  OmarchyPalette {
    id: palette
    ground: root.panelGround
  }

  readonly property color panelRaised: palette.raised
  readonly property color panelSunken: palette.sunken
  readonly property color panelLine: palette.line

  readonly property bool vertical: bar ? bar.vertical : false

  /**
   * How long the bar's open-panel mark should be.
   *
   * `Bar.qml` looks for exactly these two properties on a module and falls back to 55% of the slot
   * when a module does not offer them — a figure calibrated for a text label sitting in a padded
   * slot. Measured on the running bar: a slot 172px wide drew a 96px underline against 154px of
   * painted content, which is what "it stops short" was. This is the shell's own contract for it,
   * not a nudge: report what the module actually paints and the mark tracks it.
   */
  readonly property real openPanelIndicatorWidth: content.implicitWidth
  readonly property real openPanelIndicatorHeight: content.implicitHeight

  // ------------------------------------------------------------------------------------ reading

  function refreshAll() {
    healthRead.refresh()
    portfolioRead.refresh()
    activityRead.refresh()
    collectionsRead.refresh()
    balancesRead.refresh()
  }

  /** `refreshAll` on every instance of this widget — one per monitor. See the IPC handler below. */
  function refreshEveryBar() {
    const items = root.bar && typeof root.bar.moduleWidgets === "function"
      ? root.bar.moduleWidgets(root.moduleName) : [root]
    for (let i = 0; i < items.length; i++) {
      if (items[i] && typeof items[i].refreshAll === "function") items[i].refreshAll()
    }
  }

  function apply(key, response) {
    root.state = Model.applyRead(root.state, key, response, Date.now())
    root.nowMs = Date.now()
    if (key !== "health") snapshotDebounce.restart()
  }

  ServiceRead {
    id: healthRead
    path: "/health"
    settings: root.config
    // Local, no upstream call, and the answer decides what everything else is allowed to mean.
    interval: 60000
    startDelay: 0
    onFinished: (response) => root.apply("health", response)
  }

  ServiceRead {
    id: portfolioRead
    path: "/portfolio/value?timeframe=" + root.config.timeframe
    settings: root.config
    // At or above the service's own TTL for this resource (`ttl.portfolio` defaults to 120s), so
    // polling faster than the cache would only burn a process, never a request.
    interval: 120000
    startDelay: 400
    onFinished: (response) => root.apply("portfolio", response)
  }

  ServiceRead {
    id: activityRead
    path: "/activity"
    settings: root.config
    interval: 60000
    startDelay: 800
    onFinished: (response) => root.apply("activity", response)
  }

  ServiceRead {
    id: balancesRead
    path: "/balances"
    settings: root.config
    // Only the details view reads this, so it polls at the portfolio's own pace rather than faster,
    // and nothing on the bar waits for it.
    interval: 180000
    startDelay: 1600
    onFinished: (response) => root.apply("balances", response)
  }

  ServiceRead {
    id: collectionsRead
    path: "/collections"
    settings: root.config
    // Needs no wallet, so this is the one read that still produces something on a machine that
    // has an API key and nothing else configured.
    interval: 180000
    startDelay: 1200
    onFinished: (response) => root.apply("collections", response)
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    /**
     * `omarchy-shell anchor.pulse refresh` — useful from a hook after the service restarts.
     *
     * Fanned out, because the bar is mounted once per monitor and an IpcHandler routes to exactly
     * one of those instances. Refreshing one and leaving the others showing the old number is worse
     * than not refreshing at all: two screens disagree and neither says why.
     *
     * `BarWidget` has a `broadcast()` for this, but this widget extends `Panel` — which is a plain
     * `Item` plus the same injected contract, and does *not* inherit it. So the fan-out is spelled
     * out here over the same `bar.moduleWidgets` the base helper uses.
     */
    function refresh(): void { root.refreshEveryBar() }
  }

  /**
   * Countdown tick.
   *
   * Once a second while the panel is open, because a visible countdown that jumps in 20-second
   * steps looks broken. Once every 20 seconds otherwise: a bar label reading "1h 42m" does not
   * need a wakeup every second, and a widget that keeps a laptop's CPU out of idle forever is a
   * worse neighbour than one whose minute rolls over slightly late.
   */
  // Cheap, local, and the answer changes outside this process — the user may have installed the
  // package or run `systemctl --user enable` in a terminal since the panel was last open. The theme
  // is re-read for the same reason: `omarchy theme set` pushes to the shell over IPC, which is not
  // a path this file is on.
  onOpenedChanged: if (opened) {
    unitProbe.running = true
    palette.reload()
  }

  Timer {
    interval: root.opened ? 1000 : 20000
    repeat: true
    running: true
    onTriggered: root.nowMs = Date.now()
  }

  // --------------------------------------------------------------------------------- snapshot
  //
  // The bar must have something to show on its first frame, before any process has been spawned.

  readonly property string stateDir:
    (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/anchor"
  readonly property string snapshotPath: stateDir + "/widget-cache.json"

  Process {
    id: ensureDir
    command: ["mkdir", "-p", root.stateDir]
  }

  FileView {
    id: snapshot
    path: root.snapshotPath
    watchChanges: false
    // A torn write would show the widget a half-file forever; the rename makes it all or nothing.
    atomicWrites: true
    // A missing snapshot is the normal first run, not something to complain about in the log.
    printErrors: false
    onLoaded: root.state = Model.parseSnapshot(text())
    onLoadFailed: root.state = Model.emptyState()
  }

  Timer {
    id: snapshotDebounce
    interval: 2000
    repeat: false
    onTriggered: snapshot.setText(Model.serializeSnapshot(root.state))
  }

  Component.onCompleted: {
    ensureDir.running = true
    motionPref.running = true
    unitProbe.running = true
    // Paint from disk first; the reads have their own staggered start delays.
    snapshot.reload()
  }

  // ------------------------------------------------------------------------------------ actions

  function openUrl(url) {
    // An argv array, never a shell string: `url` is built by the model from a slug that matched
    // `[a-z0-9-]`, and passing argv means even a slug that somehow got past that cannot become a
    // second command. `Model.collectionUrl` returns null rather than guessing, and a null never
    // reaches here because the row that would carry it is not clickable.
    if (typeof url === "string" && url.startsWith("https://opensea.io/")) {
      Quickshell.execDetached(["omarchy-launch-browser", url])
    }
  }

  /**
   * Run one of the panel's actions.
   *
   * The whole safety property is that this takes an id and not a command. `Model.actionArgv` owns
   * the closed table of literal argv arrays; anything it does not recognise returns null and
   * nothing is spawned. `execDetached` takes an argv array, so even a value that somehow reached
   * the list could not become a second command.
   */
  function runAction(id) {
    const argv = Model.actionArgv(id, {
      home: Quickshell.env("HOME"),
      configHome: Quickshell.env("XDG_CONFIG_HOME"),
    })
    if (argv === null) return
    Quickshell.execDetached(argv)
    // Starting a unit is not the same as the unit being up, and `systemctl start` returns before
    // the port is listening. Re-read shortly after rather than claiming a result we did not see.
    afterAction.restart()
  }

  Timer {
    id: afterAction
    interval: 1500
    repeat: true
    triggeredOnStart: false
    property int ticks: 0
    onRunningChanged: if (running) ticks = 0
    onTriggered: {
      ticks++
      unitProbe.running = true
      root.refreshAll()
      if (ticks >= 3) running = false
    }
  }

  /**
   * What `systemctl --user` knows about the service unit.
   *
   * This decides whether the first setup step shows a button or falls back to a command, so it is
   * the difference between an action that works everywhere and one that works on the machine it was
   * written on. `LoadState` proves a unit file exists; `ActiveState` is read back afterwards
   * because a unit can load and still fail to start, and the step says so when it does.
   */
  Process {
    id: unitProbe
    command: Model.actionArgv(Model.ACTION.PROBE_SERVICE, {})
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.state = Model.applyUnitState(root.state, text)
    }
    stderr: StdioCollector { waitForEnd: true }
  }

  /**
   * Flip one boolean on this widget's bar-layout entry and persist it.
   *
   * `key` is checked against the model's own list rather than trusted, so the only settings this
   * can write are the ones the panel is allowed to offer — the same closed-table argument as
   * `Model.actionArgv`, applied to config instead of to argv.
   */
  function toggleSetting(key) {
    let allowed = false
    for (let i = 0; i < Model.BAR_ITEMS.length; i++) if (Model.BAR_ITEMS[i].key === key) allowed = true
    if (!allowed) return

    const entry = { id: root.moduleName }
    for (const existing in root.settings) if (existing !== "id") entry[existing] = root.settings[existing]
    entry[key] = root.config[key] === false
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function toggleShowValue() { root.toggleSetting("showValue") }

  // -------------------------------------------------------------------------------- the tooltip

  readonly property string ageText: {
    const age = Model.ageSeconds(root.state.portfolio, root.nowMs)
    return age === null ? "" : Model.relativeAge(age)
  }

  /**
   * One line, deliberately.
   *
   * The bar's tooltip is not ours: `Bar.qml` owns a single shared `PopupWindow` and its label is
   * hardcoded `horizontalAlignment: Text.AlignHCenter`, one colour, one weight, with no per-module
   * override. Handing that a four-line paragraph is what produced a centred block with nothing
   * leading it — the alignment was never the widget's to set. Forking the shell's tooltip to fix
   * the alignment would give Anchor a tooltip that matched nothing else on the bar.
   *
   * So the tooltip says one thing. A single centred line has no alignment problem and no hierarchy
   * to get wrong, and everything that used to be in it is a click away in the panel, where the
   * typography is ours.
   */
  readonly property string tooltip: {
    const parts = []
    if (root.portfolio.total !== null) {
      // The exact figure, ungrouped by magnitude — the bar shows "$125K", this shows what that was
      // rounded from, so the compact form never has to be trusted on its own.
      parts.push(Model.formatMoney(root.portfolio.total, { symbol: root.portfolio.symbol, exact: true }))
    }
    const detail = Model.statusDetail(root.state, root.nowMs, root.config)
    if (detail !== "") parts.push(detail)
    return parts.length === 0 ? "Anchor" : "Anchor — " + parts.join("  ·  ")
  }

  // ------------------------------------------------------------------------------- the bar item

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    tooltipText: root.tooltip
    fixedWidth: root.vertical ? -1 : content.implicitWidth + Style.spaceReal(9) * 2
    fixedHeight: root.vertical ? content.implicitHeight + Style.spaceReal(6) * 2 : -1

    onPressed: (buttonCode) => {
      if (buttonCode === Qt.RightButton) root.toggleShowValue()
      else if (buttonCode === Qt.MiddleButton) root.refreshAll()
      else root.toggle()
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.space(5)

      AnchorMark {
        anchors.verticalCenter: parent.verticalCenter
        // The square variant, because this is a row of square glyphs. The full mark is 32×45 on
        // its own grid, so fitted to a slot it draws 9×12 — the one tall, narrow thing in the bar,
        // which is exactly the complaint. `compact` swaps in geometry redrawn to 38×38, and the
        // mark now fills the slot in both directions instead of only vertically.
        //
        // `iconSize` is the mark's DRAWN size, not a canvas it sits inside: AnchorMark fits the
        // artwork to this number, and with the square variant both dimensions bind at once.
        //
        // Every neighbour is a Nerd Font glyph in a `Style.bar.iconCanvas` slot, and a glyph draws
        // to roughly its cap height inside that slot. Measured off the running bar, tray, monitor,
        // grid, bluetooth and network draw 9–11px inside a 16px canvas. So the canvas is scaled by
        // the fraction a glyph actually fills, and the mark lands at 11 — the top of the range.
        // The full mark used to take 12 to compensate for being narrow; square, it no longer has
        // to, and the row is even.
        //
        // Raising `strokeUnits` to compensate for the smaller size was tried and reverted — it
        // moved two pixels on screen, and the apparent thinness was the deliberate dim of the
        // "service not running" state rather than the stroke.
        compact: true
        iconSize: Math.round(Style.bar.iconCanvas * 0.68)
        color: root.foreground
        // Dimmed whenever the numbers beside it cannot be fully trusted — starting up, offline,
        // stale, or not yet configured. This is the widget's whole first impression on a fresh
        // install: present, legible, obviously not finished, and never alarming.
        opacity: root.label.dim ? root.dimOpacity : 1
      }

      // A vertical bar is 28px wide, so the numbers do not fit. The mark stays, and a single dot
      // says there is something to look at — the panel is one click away.
      Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.vertical
          && ((root.config.showOffers && root.label.offers > 0)
            || (root.config.showDeadline && root.label.deadline !== ""))
        width: Style.space(4)
        height: width
        radius: width / 2
        color: root.label.attention ? root.urgent : root.foreground
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && root.label.value !== ""
        textFormat: Text.PlainText
        text: root.label.value
        color: root.label.dim ? root.dim : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && root.config.showChange && root.label.change !== null && root.label.change.arrow !== ""
        textFormat: Text.PlainText
        // Direction is an arrow, not a colour: red and green fight every theme on the desktop and
        // vanish entirely for a red-green colour-blind reader. The arrow works in both cases.
        text: root.label.change === null ? "" : root.label.change.arrow + root.label.change.text
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && root.config.showOffers && root.label.offers > 0
        textFormat: Text.PlainText
        text: "◆" + root.label.offers
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && root.config.showDeadline && root.label.deadline !== ""
        textFormat: Text.PlainText
        text: "◷" + root.label.deadline
        // The only place the theme's attention colour is used, and only for a decision whose
        // window is actually closing. A bar that is always urgent is a bar nobody reads.
        color: root.label.attention ? root.urgent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        renderType: Text.NativeRendering
      }

      // Activity is the quietest thing on the bar because it needs no decision — it only says
      // something happened. Two characters, dimmed, and absent entirely when nothing has.
      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && root.config.showActivity && root.label.activity > 0
        textFormat: Text.PlainText
        text: "·" + root.label.activity
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        renderType: Text.NativeRendering
      }
    }
  }

  // ---------------------------------------------------------------------------------- the panel

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keys
    contentWidth: panel.fittedContentWidth(Style.space(360))
    // Tall enough that the details view does not scroll on a normal wallet. The default view is
    // about half this; nothing on the short path got taller, only the disclosure is allowed to be
    // long. Past the cap the scroll lane below keeps the bar out of the content.
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(720))

    PanelKeyCatcher {
      id: keys
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: (direction) => root.switchPanel(direction)
      onTextKey: (character) => {
        if (character === "r" || character === "R") root.refreshAll()
        else if (character === "v" || character === "V") root.toggleShowValue()
        else if (character === "d" || character === "D") root.detailsOpen = !root.detailsOpen
        // Keyboard parity with the button on the current step. A pill is not a tab stop, and a
        // panel that can only be finished with a pointer is not finished.
        else if (character === "s" || character === "S") {
          if (root.currentStep && root.currentStep.action) root.runAction(root.currentStep.action.id)
        }
        // Cycles the breakdown, so the tabs are reachable the same way everything else here is.
        else if (character === "b" || character === "B") {
          root.detailsOpen = true
          const keys = Model.BREAKDOWNS.map((entry) => entry.key)
          root.breakdown = keys[(keys.indexOf(root.breakdown) + 1) % keys.length]
        }
      }

      Flickable {
        id: flick
        anchors.fill: parent
        // The scrollbar's own lane — see `column` below, which is what actually reserves it.
        //
        // An attached `ScrollBar.vertical` reserves nothing: measured, it is 10px wide and sits at
        // `flick.width - 10`, painting *over* the right edge of whatever is under it. With the
        // panel's cards spanning the full width that is the card border and the row values, so the
        // moment a flick made the bar appear it read as the gutter going wrong.
        //
        // Insetting the *Flickable* was the obvious fix and the wrong one: the bar is positioned in
        // the Flickable's own coordinate space, so a right margin moves the bar inward with it and
        // the content is still underneath — now with a visibly wider gutter on one side. Insetting
        // the content column instead leaves the bar exactly where it was, in a lane of its own,
        // with a matching lane on the left so the panel stays symmetric. It is unconditional: a
        // gutter that appears when a list gets one row longer is the shift being complained about.
        readonly property int scrollLane: 10
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          x: flick.scrollLane
          width: flick.width - flick.scrollLane * 2
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Anchor"
            meta: Model.statusDetail(root.state, root.nowMs, root.config)
            detail: root.walletShort
            foreground: root.panelForeground
            fontFamily: root.fontFamily
            iconOpacity: root.label.dim ? 0.6 : 1.0

            iconComponent: Component {
              AnchorMark {
                iconSize: Style.font.display
                // Large enough for the brand's own stroke weight, which is what the mark was drawn
                // at. The lighter default exists only to survive bar size.
                strokeUnits: 5
                color: root.panelForeground
              }
            }
          }

          // ------------------------------------------------------------------- portfolio value

          PanelBlock {
            id: portfolioBlock
            color: root.panelRaised
            line: root.panelLine
            visible: root.portfolio.total !== null

            Row {
              spacing: Style.space(8)

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.config.showValue
                  ? Model.formatMoney(root.portfolio.total, { symbol: root.portfolio.symbol, exact: true })
                  : "hidden"
                color: root.panelForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.heading
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                visible: root.portfolio.change !== null
                textFormat: Text.PlainText
                text: root.portfolio.change === null ? ""
                  : root.portfolio.change.arrow + root.portfolio.change.text
                    + (root.portfolio.timeframe === "" ? "" : " / " + root.portfolio.timeframe.toLowerCase())
                color: root.panelDim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }

            // Provenance, and it stays in the default view. An age on its own is reassurance —
            // that was the earlier call and it was wrong by half. *Which addresses* plus *how old*
            // is the sentence that makes a total checkable, and it is one line either way.
            Text {
              width: parent.width
              visible: text !== ""
              textFormat: Text.PlainText
              text: root.status === Model.STATUS.OFFLINE
                ? "service unreachable — last reading " + root.ageText + " old"
                : root.status === Model.STATUS.STALE
                  ? root.provenance + "  ·  stale, retrying"
                  : root.provenance
              wrapMode: Text.WrapAtWordBoundaryOrAnywhere
              color: root.panelDim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          // --------------------------------------------------------------------- what is closing

          PanelBlock {
            id: deadlineBlock
            color: root.panelRaised
            line: root.panelLine
            visible: root.deadlines.length > 0

            PanelSectionHeader {
              text: "Closing soon"
              foreground: root.panelForeground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.deadlines

              delegate: PulseRow {
                required property var modelData
                width: parent.width
                label: modelData.name
                sublabel: [modelData.collection, modelData.amount].filter((p) => p !== "").join("  ·  ")
                value: modelData.label
                url: modelData.url === null ? "" : modelData.url
                foreground: root.panelForeground
                fontFamily: root.fontFamily
                onActivated: root.openUrl(modelData.url)
              }
            }
          }

          // ------------------------------------------------------------------------------ setup
          //
          // Not an error panel, and not a checklist either. Completed required steps leave the
          // queue and the progress segments record them; one step is current and it is the only one
          // offering a button; the optional pair is deferred behind a single line.
          //
          // There is deliberately no "Set up Anchor · step 1 of 3" header any more. Between the
          // header, the counter, the segments and the numbered discs, the panel was saying the same
          // fact four ways on open — and the hero above already names what is missing.

          PanelBlock {
            id: setupBlock
            color: root.panelRaised
            line: root.panelLine
            spacing: Style.space(7)
            visible: root.needsSetup || root.status === Model.STATUS.OFFLINE

            StepProgress {
              width: parent.width
              total: root.progress.total
              done: root.progress.done
              foreground: root.panelForeground
              animate: root.animate
            }

            Column {
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                // Done steps are filtered out here rather than hidden in the delegate: a step that
                // has been dealt with should leave the queue, not sit in it wearing a tick.
                model: root.progress.required.filter((step) => step.state !== "done")

                delegate: SetupStep {
                  required property var modelData
                  width: parent.width
                  state_: modelData.state
                  number: modelData.number
                  label: modelData.label
                  detail: modelData.detail
                  hint: modelData.hint
                  action: modelData.action
                  secondary: modelData.secondary
                  showCommand: root.detailsOpen
                  foreground: root.panelForeground
                  ground: root.panelRaised
                  wellGround: root.panelSunken
                  fontFamily: root.fontFamily
                  animate: root.animate
                  onActionTriggered: (id) => root.runAction(id)
                }
              }
            }

            // ---------------------------------------------------------------------- optional
            //
            // One line while the required path is unfinished, so the short path stays short. The
            // pill is the control, not a label: it is how you choose to look at these at all.

            Item {
              width: parent.width
              implicitHeight: Math.max(optionalPill.implicitHeight, optionalLabel.implicitHeight)
              visible: root.progress.optionalRemaining > 0

              Pill {
                id: optionalPill
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                variant: "optional"
                label: root.optionalOpen ? "optional" : root.progress.optionalRemaining + " optional"
                interactive: true
                foreground: root.panelForeground
                ground: root.panelRaised
                fontFamily: root.fontFamily
                onClicked: root.optionalOpen = !root.optionalOpen
              }

              Text {
                id: optionalLabel
                anchors.left: optionalPill.right
                anchors.leftMargin: Style.space(8)
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.optionalOpen ? "" : Model.optionalSummary(root.state)
                elide: Text.ElideRight
                color: root.panelDim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            Column {
              width: parent.width
              spacing: Style.space(6)
              visible: root.optionalOpen

              Repeater {
                model: root.progress.optional

                delegate: SetupStep {
                  required property var modelData
                  width: parent.width
                  state_: modelData.state
                  number: 0
                  label: modelData.label
                  detail: modelData.detail
                  hint: modelData.state === "done" ? "" : modelData.hint
                  action: modelData.state === "done" ? null : modelData.action
                  showCommand: root.detailsOpen
                  foreground: root.panelForeground
                  ground: root.panelRaised
                  wellGround: root.panelSunken
                  fontFamily: root.fontFamily
                  animate: root.animate
                  onActionTriggered: (id) => root.runAction(id)
                }
              }
            }
          }

          // ---------------------------------------------------------------------------- footer
          //
          // Two action buttons and one disclosure. Everything that used to compete for attention on
          // open — the value split, the age of a current reading, the floor list, the read-only
          // note — is behind that disclosure now, which is the whole point: a panel you can read in
          // a glance, with the rest one press away rather than deleted.

          Item {
            width: parent.width
            implicitHeight: Math.max(footerActions.implicitHeight, detailsPill.implicitHeight)

            Row {
              id: footerActions
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)

              PanelActionButton {
                iconText: "󰑐"
                tooltipText: "Refresh now (r)"
                foreground: root.panelDim
                hoverColor: root.panelForeground
                fontFamily: root.fontFamily
                onClicked: root.refreshAll()
              }

              PanelActionButton {
                iconText: root.config.showValue ? "󰈈" : "󰈉"
                tooltipText: root.config.showValue ? "Hide the value on the bar (v)" : "Show the value on the bar (v)"
                foreground: root.panelDim
                hoverColor: root.panelForeground
                fontFamily: root.fontFamily
                onClicked: root.toggleShowValue()
              }

              PanelActionButton {
                iconText: "󰏌"
                tooltipText: "Open this wallet on OpenSea"
                visible: root.wallets.length > 0 && Model.accountUrl(root.wallets[0]) !== null
                foreground: root.panelDim
                hoverColor: root.panelForeground
                fontFamily: root.fontFamily
                onClicked: root.openUrl(Model.accountUrl(root.wallets[0]))
              }
            }

            Pill {
              id: detailsPill
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              variant: "optional"
              label: root.detailsOpen ? "less" : "details"
              interactive: true
              foreground: root.panelForeground
              ground: root.panelGround
              fontFamily: root.fontFamily
              onClicked: root.detailsOpen = !root.detailsOpen
            }
          }

          // --------------------------------------------------------------------------- details
          //
          // Not removed — deferred. Everything here is true and occasionally wanted, and none of it
          // is worth a line on open.

          PanelBlock {
            color: root.panelRaised
            line: root.panelLine
            visible: root.detailsOpen

            // ------------------------------------------------------------ the breakdown
            //
            // Three views of one number behind one tab strip. Each states what it covers, because
            // they do not all cover the same thing — `type` is the whole portfolio, `assets` and
            // `chains` are the token half, and saying so is cheaper than a footnote nobody reads.

            Item {
              width: parent.width
              implicitHeight: breakdownTabs.implicitHeight
              visible: root.split.rows.length > 0

              Row {
                id: breakdownTabs
                anchors.left: parent.left
                spacing: Style.space(5)

                Repeater {
                  model: root.detailsOpen ? Model.BREAKDOWNS : []

                  delegate: Pill {
                    required property var modelData
                    // The chosen tab is the one thing selected here, so it takes the `recommended`
                    // weight and the rest stay `optional`. Not `required`: nothing is being asked
                    // for, and the loud variant belongs to the setup step that is.
                    variant: root.breakdown === modelData.key ? "recommended" : "optional"
                    label: modelData.label
                    interactive: true
                    toggle: true
                    foreground: root.panelForeground
                    ground: root.panelRaised
                    fontFamily: root.fontFamily
                    onClicked: root.breakdown = modelData.key
                  }
                }
              }
            }

            SplitBar {
              width: parent.width
              visible: root.split.rows.length > 0
              rows: root.detailsOpen ? root.split.rows : []
              foreground: root.panelForeground
              ground: root.panelRaised
              trackColor: root.panelSunken
              fontFamily: root.fontFamily
            }

            Text {
              width: parent.width
              visible: root.split.rows.length > 0 && text !== ""
              textFormat: Text.PlainText
              // Every view states its own total and its own scope. A share of an unstated whole is
              // the shape of a number that cannot be checked.
              text: root.split.totalText === undefined ? ""
                : "of " + root.split.totalText + "  ·  " + root.split.scope
              wrapMode: Text.WrapAtWordBoundaryOrAnywhere
              color: root.panelDim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            // An offer with no stated expiry still exists; it just has no clock to count down, so
            // it has no row above. Saying how many are unaccounted for is more honest than a list
            // that quietly holds fewer items than the bar's badge claims.
            Text {
              width: parent.width
              visible: root.label.offers > root.deadlines.length && !root.needsSetup
              textFormat: Text.PlainText
              text: (root.label.offers - root.deadlines.length) + " more offer"
                + (root.label.offers - root.deadlines.length === 1 ? "" : "s")
                + " with no stated expiry"
              wrapMode: Text.WrapAtWordBoundaryOrAnywhere
              color: root.panelDim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            PanelSectionHeader {
              visible: root.collections.length > 0
              text: "Floors"
              foreground: root.panelForeground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.detailsOpen ? root.collections : []

              delegate: PulseRow {
                required property var modelData
                width: parent.width
                label: modelData.name
                // A collection the service could not fetch keeps its row and says why. Dropping it
                // would read as one the user had removed from their config.
                sublabel: modelData.error === null ? "" : modelData.error
                value: modelData.floor === null ? "—" : modelData.floor
                faded: modelData.stale || modelData.error !== null
                url: modelData.url === null ? "" : modelData.url
                foreground: root.panelForeground
                fontFamily: root.fontFamily
                onActivated: root.openUrl(modelData.url)
              }
            }

            // ------------------------------------------------------------- what the bar shows
            //
            // The default bar is the mark, the value and a countdown. This is where the rest gets
            // switched on — five pressable pills rather than a settings page, because the whole
            // point is that adding one is as cheap as changing your mind about it.

            PanelSectionHeader {
              text: "On the bar"
              foreground: root.panelForeground
              fontFamily: root.fontFamily
            }

            Flow {
              width: parent.width
              spacing: Style.space(5)

              Repeater {
                model: root.detailsOpen ? Model.BAR_ITEMS : []

                delegate: Pill {
                  required property var modelData
                  // `done` is the vocabulary's "a fact about the past" — here, a fact about now:
                  // it ticks and drops its border, so the on ones read as a set and the off ones
                  // as offers. No second hue, and no variant louder than the step you are on.
                  variant: root.config[modelData.key] ? "done" : "optional"
                  label: modelData.label
                  interactive: true
                  toggle: true
                  foreground: root.panelForeground
                  ground: root.panelRaised
                  fontFamily: root.fontFamily
                  onClicked: root.toggleSetting(modelData.key)
                }
              }
            }

            // "Read-only. Anchor never signs, never writes, and holds no key." used to close this
            // block. It is deleted, not moved: it is a claim about the software rather than about
            // the user's wallet, it is never acted on, and it was the two lines that pushed the
            // details view past the panel's height cap and into a scroll. It is still stated in
            // `manifest.json`'s description — which is what the bar's own settings UI shows before
            // you add the widget, the moment the question is actually being asked — and in the two
            // READMEs. Say it once, where it can be looked up.
          }
        }
      }
    }
  }
}

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
//   **Every degraded state is a designed state.** The service can be down, the API key absent, the
//   wallet PAT absent, the network gone, and no wallet configured at all — five conditions that are
//   all *normal* on a fresh install. None of them renders as an error: the widget stays a calm
//   dimmed mark with a panel that says what is missing and the command that fixes it.
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
  readonly property bool needsSetup: status === Model.STATUS.SETUP || status === Model.STATUS.PARTIAL

  /**
   * Whether the optional steps are expanded.
   *
   * Bound rather than fixed, so it defaults open exactly when the optional steps *are* the point —
   * the partial state, where the required path is already done and the only thing left to show is
   * what a wallet token would add. Clicking the pill breaks the binding, which is the intended
   * QML idiom here: after that the choice is the user's.
   */
  property bool optionalOpen: root.progress.complete

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

  readonly property string walletShort: state.health && state.health.wallet
    ? Model.shortAddress(state.health.wallet) : ""

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

  readonly property bool vertical: bar ? bar.vertical : false

  // ------------------------------------------------------------------------------------ reading

  function refreshAll() {
    healthRead.refresh()
    portfolioRead.refresh()
    activityRead.refresh()
    collectionsRead.refresh()
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
    id: collectionsRead
    path: "/collections"
    settings: root.config
    // The one read that survives a missing wallet token, so it keeps running in the partial state.
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
    /** `omarchy-shell anchor.pulse refresh` — useful from a hook after the service restarts. */
    function refresh(): void { root.refreshAll() }
  }

  /**
   * Countdown tick.
   *
   * Once a second while the panel is open, because a visible countdown that jumps in 20-second
   * steps looks broken. Once every 20 seconds otherwise: a bar label reading "1h 42m" does not
   * need a wakeup every second, and a widget that keeps a laptop's CPU out of idle forever is a
   * worse neighbour than one whose minute rolls over slightly late.
   */
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

  function toggleShowValue() {
    const entry = { id: root.moduleName }
    for (const key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.showValue = root.config.showValue === false
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  // -------------------------------------------------------------------------------- the tooltip

  readonly property string ageText: {
    const age = Model.ageSeconds(root.state.portfolio, root.nowMs)
    return age === null ? "" : Model.relativeAge(age)
  }

  readonly property string tooltip: {
    const lines = [Model.statusSummary(root.state, root.nowMs, root.config)]

    if (root.portfolio.total !== null) {
      // The exact figure, ungrouped by magnitude — the bar shows "12.3K", the tooltip shows what
      // that was rounded from, so the compact form never has to be trusted on its own.
      lines.push(Model.formatMoney(root.portfolio.total, { symbol: root.portfolio.symbol, exact: true })
        + (root.ageText === "" ? "" : "  ·  " + root.ageText + " old"))
    }
    if (root.label.offers > 0) lines.push(root.label.offers + " incoming offer" + (root.label.offers === 1 ? "" : "s"))
    if (root.deadlines.length > 0) lines.push("Next closes in " + root.deadlines[0].label)
    if (root.walletShort !== "") lines.push(root.walletShort)
    return lines.join("\n")
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
        // A shade larger than the standard icon canvas, which this widget can afford because it
        // sets its own width rather than sitting in a fixed icon slot. Judged against the tray and
        // network glyphs beside it: smaller and the ring closes, larger and it towers over them.
        iconSize: Math.round(Style.bar.iconCanvas * 1.14)
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
        visible: root.vertical && (root.label.offers > 0 || root.label.deadline !== "")
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
        visible: !root.vertical && root.label.change !== null && root.label.change.arrow !== ""
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
        visible: !root.vertical && root.label.offers > 0
        textFormat: Text.PlainText
        text: "◆" + root.label.offers
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && root.label.deadline !== ""
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
        visible: !root.vertical && root.label.activity > 0
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
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keys
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: (direction) => root.switchPanel(direction)
      onTextKey: (character) => {
        if (character === "r" || character === "R") root.refreshAll()
        else if (character === "v" || character === "V") root.toggleShowValue()
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: flick.width
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

          PanelSeparator {
            width: parent.width
            foreground: root.panelForeground
            visible: portfolioBlock.visible
          }

          Column {
            id: portfolioBlock
            width: parent.width
            spacing: Style.space(2)
            visible: root.portfolio.total !== null

            PanelSectionHeader {
              text: "Portfolio"
              foreground: root.panelForeground
              fontFamily: root.fontFamily
            }

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

            Text {
              width: parent.width
              visible: root.portfolio.nftValue !== null || root.portfolio.tokenValue !== null
              textFormat: Text.PlainText
              // Both halves are quoted in the same currency the total is, by the same response.
              // Nothing here is converted; this is the split the endpoint already returned.
              text: [
                root.portfolio.nftValue === null ? ""
                  : "NFTs " + Model.formatMoney(root.portfolio.nftValue, { symbol: root.portfolio.symbol }),
                root.portfolio.tokenValue === null ? ""
                  : "Tokens " + Model.formatMoney(root.portfolio.tokenValue, { symbol: root.portfolio.symbol })
              ].filter((part) => part !== "").join("   ·   ")
              color: root.panelDim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              width: parent.width
              textFormat: Text.PlainText
              // Freshness, always, in the same place. A number without an age is a claim about now.
              text: root.status === Model.STATUS.OFFLINE
                ? "service unreachable — last reading " + root.ageText + " old"
                : root.status === Model.STATUS.STALE
                  ? "stale, " + root.ageText + " old — retrying"
                  : root.ageText === "" ? "" : "as of " + root.ageText
              color: root.panelDim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          // --------------------------------------------------------------------- what is closing

          PanelSeparator {
            width: parent.width
            foreground: root.panelForeground
            visible: deadlineBlock.visible
          }

          Column {
            id: deadlineBlock
            width: parent.width
            spacing: Style.space(2)
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
                width: column.width
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

          // An offer with no stated expiry still exists; it just has no clock to count down, so it
          // has no row above. Saying how many are unaccounted for is more honest than a list that
          // quietly holds fewer items than the bar's badge claims.
          Text {
            width: parent.width
            visible: root.label.offers > root.deadlines.length && !root.needsSetup
            textFormat: Text.PlainText
            text: (root.label.offers - root.deadlines.length) + " more offer"
              + (root.label.offers - root.deadlines.length === 1 ? "" : "s")
              + " with no stated expiry"
            color: root.panelDim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          // ----------------------------------------------------------------- watched collections

          PanelSeparator {
            width: parent.width
            foreground: root.panelForeground
            visible: collectionBlock.visible
          }

          Column {
            id: collectionBlock
            width: parent.width
            spacing: Style.space(2)
            visible: root.collections.length > 0

            PanelSectionHeader {
              text: "Floors"
              foreground: root.panelForeground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.collections

              delegate: PulseRow {
                required property var modelData
                width: column.width
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
          }

          // ------------------------------------------------------------------------------ setup
          //
          // Not an error panel, and not a checklist either. A vertical stack of five identical rows
          // reads as a chore and hides the two things that matter: how far along you are, and which
          // single thing to do next.
          //
          // So: completed required steps leave the queue and the progress segments record them; one
          // step is current and it is the only one showing a command; the optional pair is deferred
          // behind a single line that says what they buy. On a fresh install that is three lines and
          // one command instead of five rows of settings names.

          PanelSeparator {
            width: parent.width
            foreground: root.panelForeground
            visible: setupBlock.visible
          }

          Column {
            id: setupBlock
            width: parent.width
            spacing: Style.space(7)
            visible: root.needsSetup || root.status === Model.STATUS.OFFLINE

            Item {
              width: parent.width
              implicitHeight: Math.max(setupHeader.implicitHeight, setupCount.implicitHeight)

              PanelSectionHeader {
                id: setupHeader
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: root.progress.complete ? "Unlock the rest" : "Set up Anchor"
                foreground: root.panelForeground
                fontFamily: root.fontFamily
              }

              Text {
                id: setupCount
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                // Position, not just progress. "Step 2 of 3" is a promise about how much is left.
                text: root.progress.complete
                  ? root.progress.total + " of " + root.progress.total
                  : "step " + root.progress.position + " of " + root.progress.total
                color: root.panelDim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

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
                  width: column.width
                  state_: modelData.state
                  number: modelData.number
                  label: modelData.label
                  detail: modelData.detail
                  hint: modelData.hint
                  foreground: root.panelForeground
                  ground: root.panelGround
                  fontFamily: root.fontFamily
                  animate: root.animate
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
                ground: root.panelGround
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
                text: root.optionalOpen ? "" : "portfolio value, incoming offers, floor prices"
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
                  width: column.width
                  state_: modelData.state
                  number: 0
                  label: modelData.label
                  detail: modelData.detail
                  hint: modelData.state === "done" ? "" : modelData.hint
                  foreground: root.panelForeground
                  ground: root.panelGround
                  fontFamily: root.fontFamily
                  animate: root.animate
                }
              }
            }
          }

          // ---------------------------------------------------------------------------- footer

          PanelSeparator {
            width: parent.width
            foreground: root.panelForeground
          }

          Row {
            width: parent.width
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
              visible: root.state.health !== null && Model.accountUrl(root.state.health.wallet) !== null
              foreground: root.panelDim
              hoverColor: root.panelForeground
              fontFamily: root.fontFamily
              onClicked: root.openUrl(Model.accountUrl(root.state.health.wallet))
            }
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: "Read-only. Anchor never signs, never writes, and holds no key."
            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
            color: root.panelDim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}

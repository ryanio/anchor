import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "PulseModel.js" as Model

// The panel: everything Anchor shows when you click the bar.
//
// Split out of `Pulse.qml` because it is not a tooltip with extra rows — it is the whole surface,
// with a dozen states that a bar item never has. It renders from a single `state` object and asks
// the caller for nothing else, which is what makes those states reviewable: `widget/gallery`
// mounts this component against fixture readings and photographs every one of them, without a
// service, a bar, or a desktop. A panel you can only see by arranging for the condition on a live
// machine is a panel whose error states nobody has ever looked at.
//
// Everything it draws is derived here rather than passed in, for the same reason: hand it a
// reading and it is a complete picture. `Pulse.qml` keeps its own bindings for the bar item and
// the tooltip, which need the same numbers in a different shape.
//
// It takes no action itself. Every button emits a signal and the owner decides — so nothing in
// this file can spawn a process, and the gallery can mount it with the signals unconnected.
Column {
  id: root

  // ------------------------------------------------------------------------- what it renders from

  /**
   * A service reading, in the shape `PulseModel.emptyState()` returns.
   *
   * Called `reading` rather than `state` because this component's base type is an Item, and
   * `Item.state` is the QML state-machine's own property. `Pulse.qml` shadows it and gets away with
   * it only because its base type is opaque to qmllint.
   */
  property var reading: Model.emptyState()
  /** Settings, already merged — `Model.mergeSettings(...)`. */
  property var config: Model.mergeSettings({})
  /** Ticked by the owner so countdowns move. */
  property real nowMs: Date.now()
  /** The bar this hangs from, when there is one. Absent in the gallery, and nothing requires it. */
  property var bar: null
  property string fontFamily: bar ? bar.fontFamily : Style.font.family
  /** Honour `prefers-reduced-motion`; the owner reads the setting. */
  property bool animate: true

  // ------------------------------------------------------------------------------- what it wants

  /** Open a URL. Never a command — the owner holds the argv table. */
  signal openUrlRequested(string url)
  /** Run the action with this id, from the owner's closed table. */
  signal actionRequested(string id)
  /** Flip one boolean setting by key. */
  signal settingToggled(string key)
  /** Re-read everything now. */
  signal refreshRequested()

  // Named the way the body already calls them, so the body reads the same in both files.
  function openUrl(url) { root.openUrlRequested(url) }
  function runAction(id) { root.actionRequested(id) }
  function toggleSetting(key) { root.settingToggled(key) }
  function toggleShowValue() { root.settingToggled("showValue") }
  function refreshAll() { root.refreshRequested() }

  // ------------------------------------------------------------------------------------- readings

  readonly property var label: Model.barLabel(reading, nowMs, config)
  readonly property string status: label.status
  readonly property var deadlines: Model.deadlines(reading, nowMs, config)
  readonly property var portfolio: Model.readPortfolio(reading.portfolio)
  readonly property var collections: Model.collectionRows(reading, config)
  readonly property var progress: Model.setupProgress(reading)
  readonly property bool needsSetup: status === Model.STATUS.SETUP
  readonly property var wallets: Model.walletList(reading.health)

  /**
   * Where the number came from: which wallets, and how fresh.
   *
   * Not behind the disclosure, and not a debug line. A total is a claim about specific addresses at
   * a specific moment, and a panel that prints the figure without either is asking to be believed
   * rather than read. This project has already had one afternoon of a plausible number being taken
   * for a true one.
   */
  readonly property string provenance: Model.provenance(root.reading, root.nowMs, root.config)

  /**
   * The hero's trailing pill. One wallet gets its short address; several get a count, because six
   * truncated hex strings is not information, it is a wall.
   */
  readonly property string walletShort: root.wallets.length === 0
    ? ""
    : root.wallets.length === 1
      ? Model.shortAddress(root.wallets[0])
      : root.wallets.length + " wallets"

  readonly property string ageText: {
    const age = Model.ageSeconds(root.reading.portfolio, root.nowMs)
    return age === null ? "" : Model.relativeAge(age)
  }

  // ------------------------------------------------------------------------------------ view state

  /** Which breakdown the details view is showing. Never affects the default view. */
  property string breakdown: "type"
  readonly property var split: Model.portfolioBreakdown(root.reading, root.config, root.breakdown)

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

  /** The step being worked on, so a keyboard can reach the same button a pointer can. */
  readonly property var currentStep: {
    const steps = root.progress.required
    for (let i = 0; i < steps.length; i++) if (steps[i].state === "current") return steps[i]
    return null
  }

  // ------------------------------------------------------------------------------ theme colours
  //
  // The panel's own surface, not the bar's, and none of it is a hardcoded palette — every value is
  // the user's live Omarchy theme. With no bar (the gallery) the theme's own colours stand in,
  // which is what a bar would have resolved to anyway.

  readonly property color panelForeground: bar ? bar.foreground : Color.foreground
  readonly property color panelDim: Qt.darker(panelForeground, 1.5)
  readonly property color panelGround: Color.popups.background
  readonly property color urgent: bar ? bar.urgent : Color.urgent

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

  // ------------------------------------------------------------------------------------ the panel

  spacing: Style.space(12)

  PanelHero {
    width: parent.width
    title: "Anchor"
    meta: Model.statusDetail(root.reading, root.nowMs, root.config)
    detail: root.walletShort
    foreground: root.panelForeground
    fontFamily: root.fontFamily
    iconOpacity: root.label.dim ? 0.6 : 1.0

    iconComponent: Component {
      AnchorMark {
        iconSize: Style.font.display
        // `anchor.svg`'s weight rather than the default. The default is `anchor-solid.svg`'s 6,
        // which exists so the stroke clears one device pixel in a bar slot; at hero size there is
        // room for the lighter of the two.
        strokeUnits: 4.5
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
        text: root.optionalOpen ? "" : Model.optionalSummary(root.reading)
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

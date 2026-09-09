import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "PulseModel.js" as Model

// The bar item: the mark, the value, and the small counts beside it.
//
// Split out of `Pulse.qml` for the reason `PanelContent.qml` was — it has states, and a live machine
// is in one of them. Dim on a fresh install, a value once a wallet resolves, a badge when offers are
// waiting, a countdown when one is closing, a single dot when the bar is vertical and there is no
// room for any of it. `widget/gallery/` mounts this against a fixture per state and photographs each
// one, which is the only way anybody sees the ones that are not today's.
//
// It renders from a reading and paints. It has no click handling, no processes, and no service —
// `Pulse.qml` wraps it in the button that does all three.
Row {
  id: root

  /** A service reading, in the shape `PulseModel.emptyState()` returns. */
  property var reading: Model.emptyState()
  /** Settings, already merged — `Model.mergeSettings(...)`. */
  property var config: Model.mergeSettings({})
  /** Ticked by the owner so countdowns move. */
  property real nowMs: Date.now()
  /** A vertical bar is 28px wide, so the numbers do not fit and the item says less. */
  property bool vertical: false

  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color dim: foreground
  property real dimOpacity: 1
  property string fontFamily: Style.font.family

  readonly property var label: Model.barLabel(reading, nowMs, config)

  spacing: Style.space(5)


AnchorMark {
  anchors.verticalCenter: parent.verticalCenter
  // `iconSize` is the mark's DRAWN size, not a canvas it sits inside: AnchorMark fits the
  // artwork to this number, and the artwork is square, so both dimensions bind at once.
  //
  // Every neighbour is a Nerd Font glyph in a `Style.bar.iconCanvas` slot, and a glyph draws
  // to roughly its cap height inside that slot. Measured off the running bar, tray, monitor,
  // grid, bluetooth and network draw 9–11px inside a 16px canvas. So the canvas is scaled by
  // the fraction a glyph actually fills, and the mark lands at 11 — the top of that range,
  // which a square glyph can take without looking large.
  //
  // The stroke is the other half, and it is why the mark is drawn the way it is: at this size
  // the old full anchor's stroke computed to 0.93 device pixels. Under one, so it antialiased
  // to grey — starved, not thin, and unfixable by any change of size.
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

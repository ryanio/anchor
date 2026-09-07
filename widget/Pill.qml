import QtQuick
import qs.Commons
import "PulseModel.js" as Model

// A small semantic label. Same vocabulary as `theme/components.css` — `required`, `recommended`,
// `optional`, `done` — implemented against the live Omarchy palette rather than Anchor's own,
// because a bar widget has to wear the desktop's colours rather than the project's.
//
// The variant chooses *weight*, never hue. That is what keeps the house rule — one accent per view
// — enforceable rather than aspirational: with only one emphasis level available and only one
// element allowed to use it, a screen full of shouting pills is not expressible. `required` is the
// loud one. Everything else is quiet by construction.
//
// `optional` is worded and drawn as permission rather than warning: it is the affordance that lets
// someone skip a step, so it must not look like something has gone wrong.
Item {
  id: root

  property string variant: "optional"
  property string label: ""
  property color foreground: Color.foreground
  /** The surface the pill sits on. Needed to keep faded text above the WCAG floor — see below. */
  property color ground: Color.background
  property string fontFamily: Style.font.family
  property bool interactive: false

  signal clicked()

  readonly property bool _required: variant === "required"
  readonly property bool _done: variant === "done"
  readonly property bool _recommended: variant === "recommended"

  /**
   * Text opacity, clamped to what this theme can carry.
   *
   * `scripts/check-contrast.ts` gates the CSS side of this component set at build time. It cannot
   * gate this one, because these colours are the user's current Omarchy theme, read at runtime —
   * so the same WCAG arithmetic runs here on the live values and refuses to fade further than the
   * theme allows. A pill nobody can read is worse than a pill that is louder than intended.
   */
  readonly property real _textAlpha: {
    const desired = root._required ? 1.0 : root._recommended ? 0.8 : root._done ? 0.5 : 0.62
    return Model.dimAlpha(root.foreground, root.ground, desired, 3)
  }

  readonly property real _borderAlpha: root._done ? 0 : root._required ? 0.55 : root._recommended ? 0.3 : 0.22
  readonly property real _fillAlpha: root._required ? 0.1 : 0

  readonly property string _prefix: root._done ? "✓ " : ""
  readonly property string _suffix: root.interactive ? "  ›" : ""

  implicitWidth: text.implicitWidth + Style.space(14)
  implicitHeight: text.implicitHeight + Style.space(5)

  Rectangle {
    anchors.fill: parent
    radius: height / 2
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b,
                   root._fillAlpha + (mouse.containsMouse ? 0.07 : 0))
    border.width: root._borderAlpha > 0 ? 1 : 0
    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root._borderAlpha)
  }

  Text {
    id: text
    anchors.centerIn: parent
    textFormat: Text.PlainText
    text: root._prefix + root.label + root._suffix
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root._textAlpha)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  MouseArea {
    id: mouse
    anchors.fill: parent
    enabled: root.interactive
    hoverEnabled: root.interactive
    cursorShape: root.interactive ? Qt.PointingHandCursor : Qt.ArrowCursor
    onClicked: root.clicked()
  }
}

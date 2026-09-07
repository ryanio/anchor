import QtQuick
import qs.Commons

// One line in the panel: a name on the left, a value on the right, and an optional click.
//
// Three text roles, and they are the whole hierarchy: the **value** leads (full strength, bold),
// the **name** identifies (full strength, regular), the **sub-line** supports (dimmed, caption).
// Drawing the name and the value at the same weight and colour is what makes a list of them read
// as a wall — the eye has nothing to land on, and every row costs as much attention as every other.
//
// Every string that reaches this component has already been through `Model.sanitize`, and both
// labels render as `Text.PlainText`. That pairing is deliberate: sanitising alone would still let
// a name containing markup be interpreted if some future edit changed the format, and PlainText
// alone would still let a bidi override reorder the row. Neither defence is load-bearing by itself.
Item {
  id: root

  property string label: ""
  property string sublabel: ""
  property string value: ""
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family
  /** Faded for a row whose data is stale or whose fetch failed. */
  property bool faded: false
  /** Set to make the row clickable. Empty means it is not a link, and it will not look like one. */
  property string url: ""

  signal activated()

  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property bool interactive: url !== ""

  implicitHeight: Math.max(labels.implicitHeight, valueText.implicitHeight) + Style.space(6)
  opacity: faded ? 0.55 : 1

  Rectangle {
    anchors.fill: parent
    anchors.leftMargin: -Style.space(6)
    anchors.rightMargin: -Style.space(6)
    radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(4)
    // (foreground, accent, urgent) — all three, because the theme's `hover` token decides which one
    // it resolves to, and a theme that names `urgent` got `undefined` from the two-argument call.
    color: Style.hoverFillFor(root.foreground, root.foreground, root.foreground)
    visible: root.interactive && mouse.containsMouse
  }

  Column {
    id: labels
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    anchors.right: valueText.left
    anchors.rightMargin: Style.space(10)
    spacing: Style.space(1)

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.label
      elide: Text.ElideRight
      maximumLineCount: 1
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }


    Text {
      width: parent.width
      visible: root.sublabel !== ""
      textFormat: Text.PlainText
      text: root.sublabel
      elide: Text.ElideRight
      maximumLineCount: 1
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  Text {
    id: valueText
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    textFormat: Text.PlainText
    text: root.value
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    // The answer, not the label: a countdown in "Closing soon", a floor in "Floors". Weight rather
    // than size, so the row keeps one line height and the column keeps its rhythm.
    font.bold: true
  }

  MouseArea {
    id: mouse
    anchors.fill: parent
    enabled: root.interactive
    hoverEnabled: true
    cursorShape: root.interactive ? Qt.PointingHandCursor : Qt.ArrowCursor
    onClicked: root.activated()
  }
}

import QtQuick
import qs.Commons

// A group of rows, lifted off the panel's ground.
//
// This replaced the hairline separators the panel used to divide itself with. The separators were
// doing two jobs badly: saying where one group ended, and giving the eye somewhere to rest. A
// surface does both with one element, and it is the thing that makes the panel read as having
// depth rather than as one flat sheet of text — which was the complaint.
//
// `surface` is the active Omarchy theme's own raised colour (see `OmarchyPalette`), never an Anchor
// one. The edge is a hairline of the theme's `selection`, not a border in the CSS sense: at these
// contrast steps a surface alone can disappear against a wallpaper showing through a translucent
// popup, and the hairline is what keeps the group readable when it does.
Rectangle {
  id: root

  property real padding: Style.space(10)
  property color line: "transparent"
  property alias spacing: inner.spacing

  /** Children go into the inner column, so a caller writes rows and never geometry. */
  default property alias content: inner.data

  width: parent ? parent.width : implicitWidth
  implicitHeight: inner.implicitHeight + padding * 2
  radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(8)
  border.width: 1
  border.color: root.line

  Column {
    id: inner
    x: root.padding
    y: root.padding
    width: root.width - root.padding * 2
    spacing: Style.space(3)
  }
}

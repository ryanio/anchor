import QtQuick
import qs.Commons

// How far through setup you are, as a shape rather than a sentence.
//
// This exists because completed steps *leave* the list: without a record of them, finishing one
// would make the panel shorter and give no sense of having got anywhere. The segments are that
// record, and they are the only place in the widget that moves.
Item {
  id: root

  property int total: 3
  property int done: 0
  property color foreground: Color.foreground
  /** Set false for `prefers-reduced-motion`. The bar still fills; it just does not animate there. */
  property bool animate: true

  implicitHeight: Style.space(3)
  implicitWidth: Style.space(120)

  Row {
    anchors.fill: parent
    spacing: Style.space(3)

    Repeater {
      model: root.total

      delegate: Rectangle {
        required property int index

        width: (root.width - (root.total - 1) * Style.space(3)) / root.total
        height: root.height
        radius: height / 2

        readonly property bool filled: index < root.done

        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, filled ? 0.85 : 0.16)

        // The one moment of motion in the widget: a segment fading up as its step completes. Slow
        // enough to notice, small enough to ignore, and nothing else on screen competes with it.
        Behavior on color {
          enabled: root.animate
          ColorAnimation { duration: 420; easing.type: Easing.OutCubic }
        }
      }
    }
  }
}

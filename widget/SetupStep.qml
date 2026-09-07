import QtQuick
import qs.Commons
import "PulseModel.js" as Model

// One step of setup: a numbered marker, what the step gets you, and — only for the step you are
// actually on — the command that does it.
//
// Numbering is usually decoration on a UI list. It is not here: these steps are a genuine
// sequence, and an API key stored before the service is running cannot be verified. So the number
// encodes something true, and only the current step shows its command, because offering a command
// for a step that cannot succeed yet is an invitation to run it and watch it fail.
//
// The marker is the whole emphasis budget. `current` is a filled disc with the number knocked out
// of it — legible on any theme, and built from the theme's own two colours rather than a new one.
Item {
  id: root

  /** "done" · "current" · "upcoming" · "optional" */
  property string state_: "upcoming"
  property int number: 0
  property string label: ""
  property string detail: ""
  property string hint: ""
  property color foreground: Color.foreground
  property color ground: Color.background
  property string fontFamily: Style.font.family
  property bool animate: true

  readonly property bool isCurrent: state_ === "current"
  readonly property bool isDone: state_ === "done"

  readonly property real _labelAlpha:
    Model.dimAlpha(foreground, ground, isCurrent ? 1.0 : isDone ? 0.5 : 0.78, 3)
  readonly property real _detailAlpha: Model.dimAlpha(foreground, ground, 0.55, 3)

  readonly property real markerSize: Style.space(18)

  implicitHeight: body.implicitHeight + Style.space(6)

  // ------------------------------------------------------------------------------- the marker

  Item {
    id: marker
    width: root.markerSize
    height: root.markerSize
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.topMargin: Style.space(1)

    Rectangle {
      id: disc
      anchors.fill: parent
      radius: width / 2
      color: root.isCurrent
        ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.92)
        : "transparent"
      border.width: root.isCurrent ? 0 : 1
      border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b,
                            root.isDone ? 0.3 : 0.42)

      Behavior on color {
        enabled: root.animate
        ColorAnimation { duration: 320; easing.type: Easing.OutCubic }
      }
    }

    // A slow halo on the step you are on, so the eye lands there first when the panel opens. One
    // beacon, not five — every other step is static.
    Rectangle {
      anchors.centerIn: parent
      width: parent.width + Style.space(6)
      height: width
      radius: width / 2
      color: "transparent"
      visible: root.isCurrent && root.animate
      border.width: 1
      border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.35)

      SequentialAnimation on opacity {
        running: root.isCurrent && root.animate
        loops: Animation.Infinite
        NumberAnimation { from: 0.0; to: 0.7; duration: 1400; easing.type: Easing.InOutSine }
        NumberAnimation { from: 0.7; to: 0.0; duration: 1400; easing.type: Easing.InOutSine }
      }
    }

    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: root.isDone ? "✓" : String(root.number)
      // Knocked out of the filled disc, so the number stays readable whatever the theme is.
      color: root.isCurrent
        ? root.ground
        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root.isDone ? 0.5 : 0.7)
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: root.isCurrent
    }
  }

  // --------------------------------------------------------------------------------- the body

  Column {
    id: body
    anchors.left: marker.right
    anchors.leftMargin: Style.space(9)
    anchors.right: parent.right
    anchors.top: parent.top
    spacing: Style.space(2)

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.label
      wrapMode: Text.WrapAtWordBoundaryOrAnywhere
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root._labelAlpha)
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }

    // The detail earns its line only on the step being worked on, and on the optional steps, where
    // it is the argument for bothering at all. On an upcoming step it is noise.
    Text {
      width: parent.width
      visible: root.detail !== "" && (root.isCurrent || root.state_ === "optional")
      textFormat: Text.PlainText
      text: root.detail
      wrapMode: Text.WrapAtWordBoundaryOrAnywhere
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root._detailAlpha)
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }

    Item {
      width: parent.width
      height: hintText.implicitHeight + Style.space(8)
      visible: root.hint !== "" && (root.isCurrent || root.state_ === "optional")

      Rectangle {
        anchors.fill: parent
        anchors.topMargin: Style.space(2)
        radius: Style.space(4)
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
      }

      Text {
        id: hintText
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.leftMargin: Style.space(7)
        anchors.rightMargin: Style.space(7)
        anchors.verticalCenter: parent.verticalCenter
        anchors.verticalCenterOffset: Style.space(1)
        textFormat: Text.PlainText
        text: root.hint
        wrapMode: Text.WrapAnywhere
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root._detailAlpha)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}

import QtQuick
import qs.Commons
import "PulseModel.js" as Model

// One step of setup: a numbered marker, what the step gets you, and — only for the step you are
// actually on — the button that does it.
//
// Numbering is usually decoration on a UI list. It is not here: these steps are a genuine
// sequence, and an API key stored before the service is running cannot be verified. So the number
// encodes something true.
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
  /** `{ id, label }` from the model, or null. The id is all the panel ever passes on. */
  property var action: null
  property var secondary: null
  /** The raw command is advanced detail; the parent's disclosure decides whether it is shown. */
  property bool showCommand: false
  property color foreground: Color.foreground
  property color ground: Color.background
  /** The sunken surface the command sits on. Its own colour, so the fade is measured against it. */
  property color wellGround: ground
  property string fontFamily: Style.font.family
  property bool animate: true

  signal actionTriggered(string id)

  readonly property bool isCurrent: state_ === "current"
  readonly property bool isDone: state_ === "done"
  readonly property bool isOptional: state_ === "optional"
  readonly property bool actionable: (isCurrent || isOptional) && action !== null

  readonly property real _labelAlpha:
    Model.dimAlpha(foreground, ground, isCurrent ? 1.0 : isDone ? 0.5 : 0.78, 3)
  readonly property real _detailAlpha: Model.dimAlpha(foreground, ground, 0.55, 3)
  /** Measured against the *well*, not the panel: it is a different surface now, and darker. */
  readonly property real _hintAlpha: Model.dimAlpha(foreground, wellGround, 0.62, 4.5)

  readonly property real markerSize: Style.space(18)

  // ------------------------------------------------------- marker geometry, measured not guessed
  //
  // The marker used to be anchored to the top of the row with a fixed 1px margin, which made its
  // centre land at `markerSize / 2 + 1` — a number with no relationship to the text beside it. At
  // this font that put the disc 2.1px below the title's cap-height centre, and the error grew with
  // `[font] base-size`, because one side of the comparison scaled and the other did not.
  //
  // Inside the disc a second error ran the other way: `anchors.centerIn` centres a *line box*, and
  // a digit's line box is 14px tall at 10px where the digit itself paints 8 (JetBrainsMono Nerd
  // Font: ascent 10.19, descent 3.0, digit tight box 8.0 from the baseline up, measured with
  // TextMetrics). Centring the box put the numeral 0.8px above the disc's centre. A low disc with a
  // high numeral inside it is why nudging either number never converged — they were cancelling.
  //
  // So both are derived from font metrics now: the glyph sits on the title's own baseline, and the
  // disc is centred on the glyph's *ink*, not on its line box or the marker's bounding box.

  FontMetrics {
    id: labelMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
  }

  FontMetrics {
    id: numeralMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.bold: true
  }

  // A reference digit rather than the glyph on screen, so every disc in the column sits at the same
  // height: "✓" paints one pixel shorter than a digit and would otherwise shift its own row.
  TextMetrics {
    id: digitInk
    font: numeralMetrics.font
    text: "0"
  }

  // The glyph actually drawn, for the horizontal correction. On a monospaced family this measures
  // zero — every digit's ink fills its advance — but on a proportional one "1" is visibly narrow,
  // and a disc centred on the advance is not centred on the mark.
  TextMetrics {
    id: glyphInk
    font: numeralMetrics.font
    text: root.isDone ? "✓" : String(root.number)
  }

  readonly property real _inkHalf: digitInk.tightBoundingRect.height / 2
  /** Whole pixels, so the title's baseline stays on the grid the rest of the panel uses. */
  readonly property int _topInset: Math.max(0, Math.round(markerSize / 2 + _inkHalf - labelMetrics.ascent))
  readonly property real _baselineY: _topInset + labelMetrics.ascent
  readonly property real _markerY: _baselineY - _inkHalf - markerSize / 2

  implicitHeight: _topInset + body.implicitHeight + Style.space(6)

  // ------------------------------------------------------------------------------- the marker

  Item {
    id: marker
    x: 0
    y: root._markerY
    width: root.markerSize
    height: root.markerSize

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
      id: numeral
      // Baseline-aligned to the first line of the title, then corrected horizontally onto the
      // glyph's painted centre. `y` rather than an anchor because the thing being aligned to is
      // in a sibling item's coordinate space.
      x: parent.width / 2 - (glyphInk.tightBoundingRect.x + glyphInk.tightBoundingRect.width / 2)
      y: root._baselineY - marker.y - numeralMetrics.ascent
      textFormat: Text.PlainText
      text: root.isDone ? "✓" : String(root.number)
      // Knocked out of the filled disc, so the number stays readable whatever the theme is.
      color: root.isCurrent
        ? root.ground
        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root.isDone ? 0.5 : 0.7)
      font: numeralMetrics.font
      renderType: Text.NativeRendering
    }
  }

  // --------------------------------------------------------------------------------- the body

  Column {
    id: body
    anchors.left: marker.right
    anchors.leftMargin: Style.space(9)
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.topMargin: root._topInset
    spacing: Style.space(2)

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.label
      wrapMode: Text.WrapAtWordBoundaryOrAnywhere
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root._labelAlpha)
      font.family: labelMetrics.font.family
      font.pixelSize: labelMetrics.font.pixelSize
      // The step you are on is the one thing to read here. `_labelAlpha` already separates it from
      // the rest; weight is what makes that legible at a glance rather than on comparison.
      font.bold: root.isCurrent
    }

    // The detail earns its line only on the step being worked on, and on the optional steps, where
    // it is the argument for bothering at all. On an upcoming step it is noise.
    Text {
      width: parent.width
      visible: root.detail !== "" && (root.isCurrent || root.isOptional)
      textFormat: Text.PlainText
      text: root.detail
      wrapMode: Text.WrapAtWordBoundaryOrAnywhere
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root._detailAlpha)
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }

    // The step's own action. A setup step should do the thing rather than describe it, so this is
    // the control and the command below is the footnote — the reverse of how it shipped.
    Item {
      width: parent.width
      height: root.actionable ? actions.implicitHeight + Style.space(6) : 0
      visible: root.actionable

      Row {
        id: actions
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        spacing: Style.space(6)

        Pill {
          // Loud only on the step you are on. An optional step's button is an offer, not an ask,
          // and two loud pills in one panel is the thing the one-accent rule exists to prevent.
          variant: root.isCurrent ? "required" : "recommended"
          label: root.action ? root.action.label : ""
          interactive: true
          foreground: root.foreground
          ground: root.ground
          fontFamily: root.fontFamily
          onClicked: if (root.action) root.actionTriggered(root.action.id)
        }

        Pill {
          visible: root.secondary !== null
          variant: "optional"
          label: root.secondary ? root.secondary.label : ""
          interactive: true
          foreground: root.foreground
          ground: root.ground
          fontFamily: root.fontFamily
          onClicked: if (root.secondary) root.actionTriggered(root.secondary.id)
        }
      }
    }

    Item {
      width: parent.width
      height: hintText.implicitHeight + Style.space(8)
      visible: root.hint !== "" && root.showCommand && (root.isCurrent || root.isOptional)

      Rectangle {
        anchors.fill: parent
        anchors.topMargin: Style.space(2)
        radius: Style.space(4)
        // An opaque surface from the theme rather than a tint of the foreground: a tint over an
        // unknown ground is exactly the colour a contrast check cannot measure.
        color: root.wellGround
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
        // Breaks at a space first and only splits a token when it has to: `WrapAnywhere` alone
        // rendered a path as "config.j / son", which reads as a typo rather than as a wrap.
        wrapMode: Text.WrapAtWordBoundaryOrAnywhere
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root._hintAlpha)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}

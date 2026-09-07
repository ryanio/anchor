import QtQuick
import qs.Commons

// A part-to-whole split: one bar, and a labelled row per part.
//
// **Not a pie.** Two or three parts of a whole is a ratio, and a pie of two slices is the canonical
// way to make a ratio harder to read than the sentence it replaced. A stacked bar is the form for
// part-to-whole; every segment carries its own name, value and share as text beside it, so the bar
// is the shape of the answer and the rows are the answer. Nothing here can only be read from the
// legend, because there is no legend.
//
// **One hue, more is stronger.** The parts are magnitudes, not identities: they are ordered by size
// and there is nothing to tell apart that the labels do not already say. So this is a sequential
// scale — the theme's foreground at descending strengths — rather than a categorical palette, and
// it needs no second colour on a desktop that has not offered one. Segments are separated by a
// gap of the surface behind them rather than by a border, which is what keeps two adjacent
// strengths distinguishable without adding an edge.
//
// Text never wears a segment's colour. Values and labels stay in the panel's own text strengths;
// the swatch beside a row is what carries identity.
Item {
  id: root

  /** `[{ label, text, share }]` from `Model.portfolioBreakdown`. Shares are 0–1. */
  property var rows: []
  property color foreground: Color.foreground
  property color ground: Color.background
  /** The track the segments sit in — the sunken surface, so an empty bar still reads as a bar. */
  property color trackColor: ground
  property string fontFamily: Style.font.family

  readonly property real barHeight: Style.space(8)
  readonly property int gap: Style.space(2)

  /**
   * Strength per rank, darkest first.
   *
   * Six steps because the model folds the tail into one row at five parts plus an "n more" —
   * past that the steps stop separating and the fold is the answer, not another shade.
   */
  //
  // The first two steps are deliberately far apart. At 0.85/0.55 a 90/10 split drew two swatches
  // that read as the same grey at 7px, which is the failure mode of a sequential scale: the ramp
  // is smooth and the eye needs a step. Halving the strength between rank 1 and 2 separates the
  // pair that matters most, and the tail compresses because by then the labels are doing the work.
  readonly property var strengths: [0.9, 0.45, 0.3, 0.22, 0.17, 0.13]

  function strengthAt(index) {
    return root.strengths[Math.min(index, root.strengths.length - 1)]
  }

  function fill(index) {
    return Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, root.strengthAt(index))
  }

  implicitHeight: bar.height + Style.space(6) + labels.implicitHeight

  Rectangle {
    id: bar
    width: parent.width
    height: root.barHeight
    radius: height / 2
    color: root.trackColor

    Row {
      anchors.fill: parent
      spacing: root.gap

      Repeater {
        model: root.rows

        delegate: Rectangle {
          required property var modelData
          required property int index

          // The gaps come out of the segments rather than out of the track, so the parts still
          // add up to the whole: a bar whose segments sum to less than its width is a rounding
          // error the reader can see.
          width: Math.max(
            0,
            (bar.width - (root.rows.length - 1) * root.gap) * (Number(modelData.share) || 0))
          height: parent.height
          radius: height / 2
          color: root.fill(index)
        }
      }
    }
  }

  Column {
    id: labels
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: bar.bottom
    anchors.topMargin: Style.space(6)
    spacing: Style.space(3)

    Repeater {
      model: root.rows

      delegate: Item {
        required property var modelData
        required property int index

        width: labels.width
        implicitHeight: Math.max(rowLabel.implicitHeight, rowValue.implicitHeight)

        Rectangle {
          id: swatch
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(7)
          height: width
          radius: width / 2
          color: root.fill(index)
        }

        Text {
          id: rowLabel
          anchors.left: swatch.right
          anchors.leftMargin: Style.space(7)
          anchors.right: rowValue.left
          anchors.rightMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: modelData.label
          elide: Text.ElideRight
          maximumLineCount: 1
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          id: rowValue
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          // The amount leads and the share supports it: a percentage without the figure behind it
          // is the part of a chart people quote and cannot check.
          // A share that rounds to zero is not zero, and printing "0%" beside a real amount asks
          // the reader to reconcile two things that cannot both be true.
          readonly property real pct: (Number(modelData.share) || 0) * 100
          text: modelData.text + "   " + (pct > 0 && pct < 0.5 ? "<1" : Math.round(pct)) + "%"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }
      }
    }
  }
}

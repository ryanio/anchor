import QtQuick
import QtQuick.Shapes

// Anchor's mark, drawn rather than loaded.
//
// The geometry is `site/brand/anchor-solid.svg` verbatim on its 64-unit grid — an anchor that reads
// as an A. It is redrawn here instead of shipped as an asset for the reason the brand README gives
// for inlining the SVG on the site: the mark carries no colour of its own and takes its context's.
// `color` is bound to the bar's foreground by the caller, so the mark follows whichever Omarchy
// theme is applied, live, with no per-theme asset and no recolouring step.
//
// The one thing that is *not* taken from the SVG is the framing. The artwork occupies roughly
// x 16–48, y 5–50 of its 64-unit viewBox — a little over half the width and two thirds of the
// height — so scaling the viewBox to a 16px bar slot renders a 10px mark surrounded by padding,
// with strokes thick enough to close up the ring. Fitting the artwork's own bounds instead makes
// the mark as large as the slot allows, which is what lets the ring stay open at bar size.
Item {
  id: root

  property real iconSize: 16
  property color color: "white"
  /**
   * Stroke weight in the artwork's own 64-unit grid.
   *
   * The brand's solid variant is 6, and the default here is much lighter, because fitting to the
   * artwork bounds enlarges the stroke along with everything else. Compared side by side, 4.5 and
   * above close the ring into a dot and the mark stops reading as an anchor; 3.5 keeps it open at
   * every size a bar uses, which is 12px on this one. Callers drawing the mark large — the panel
   * hero — pass the brand's own weight instead.
   */
  property real strokeUnits: 3.5

  implicitWidth: iconSize
  implicitHeight: iconSize
  width: iconSize
  height: iconSize

  // Artwork bounds, inflated by half a stroke so the outer edge of the stroke is what gets fitted
  // rather than the path centreline — otherwise the mark is clipped by exactly half a stroke.
  readonly property real _pad: strokeUnits / 2
  readonly property real _left: 16 - _pad
  readonly property real _top: 5 - _pad
  readonly property real _w: (48 + _pad) - _left
  readonly property real _h: (50 + _pad) - _top

  readonly property real _scale: Math.min(iconSize / _w, iconSize / _h)

  Shape {
    id: shape
    width: root.iconSize
    height: root.iconSize
    antialiasing: true
    // Applied in list order: move the artwork's own origin to 0,0, scale it to the slot, then
    // centre what is left over.
    transform: [
      Translate { x: -root._left; y: -root._top },
      Scale { xScale: root._scale; yScale: root._scale },
      Translate {
        x: (root.iconSize - root._w * root._scale) / 2
        y: (root.iconSize - root._h * root._scale) / 2
      }
    ]

    ShapePath {
      strokeColor: root.color
      fillColor: "transparent"
      // In artwork units; the Scale above carries it to device pixels with everything else.
      strokeWidth: root.strokeUnits
      capStyle: ShapePath.RoundCap
      joinStyle: ShapePath.RoundJoin

      // ring · shank left · shank right · crossbar · fluke left · fluke right
      PathSvg {
        path: "M 27 10 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0 " +
              "M 32 15 L 21 50 " +
              "M 32 15 l 11 35 " +
              "M 25 34 h 14 " +
              "M 21 50 c -3 -1 -5 -4 -5 -8 " +
              "M 43 50 c 3 -1 5 -4 5 -8"
      }
    }
  }
}

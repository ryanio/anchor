import QtQuick
import QtQuick.Shapes

// Anchor's mark, drawn rather than loaded.
//
// The geometry is `site/brand/anchor.svg` verbatim on its 64-unit grid. It is redrawn here instead
// of shipped as an asset for the reason the brand README gives for inlining the SVG on the site:
// the mark carries no colour of its own and takes its context's. `color` is bound to the bar's
// foreground by the caller, so it follows whichever Omarchy theme is applied, live, with no
// per-theme asset and no recolouring step.
//
// One drawing at every size: a ring, two arms, a crossbar. Each arm carries its own fluke as a
// curve at the end of the same path, which is why the mark reads as an anchor and still survives an
// 11px slot — four elements set the stroke weight, and folding the flukes in costs none.
//
// The one thing that is *not* taken from the SVG is the framing. The artwork does not fill its
// viewBox, so scaling the viewBox to a bar slot renders a small mark surrounded by padding. Fitting
// the artwork's own bounds instead makes it as large as the slot allows, which is what lets the
// ring stay open at bar size.
Item {
  id: root

  property real iconSize: 16
  property color color: "white"

  /**
   * Stroke weight in the artwork's own 64-unit grid.
   *
   * 6 is `anchor-solid.svg`'s weight and the default because the bar is the hard case: fitted to an
   * 11px slot it draws 1.57 device pixels. Anything lighter lands under one, where the stroke
   * antialiases to grey and reads as starved rather than fine. Callers with room — the panel hero —
   * pass `anchor.svg`'s 4.5 instead, which is the same drawing set for a size that can carry it.
   */
  property real strokeUnits: 6

  implicitWidth: iconSize
  implicitHeight: iconSize
  width: iconSize
  height: iconSize

  // Path centreline bounds of whichever variant is drawn, straight off the SVG.
  readonly property real _x0: 13
  readonly property real _x1: 51
  readonly property real _y0: 7
  readonly property real _y1: 45

  // Inflated by half a stroke so the outer edge of the stroke is what gets fitted rather than the
  // centreline — otherwise the mark is clipped by exactly half a stroke.
  readonly property real _pad: strokeUnits / 2
  readonly property real _left: _x0 - _pad
  readonly property real _top: _y0 - _pad
  readonly property real _w: (_x1 + _pad) - _left
  readonly property real _h: (_y1 + _pad) - _top

  readonly property real _scale: Math.min(iconSize / _w, iconSize / _h)

  // ring · arm left · arm right · crossbar. Each arm is one path: the shank down and out, then the
  // fluke curling back up as a continuation of it rather than as a stroke of its own. That is the
  // whole trick — the flukes are free, because the element count is what sets the stroke weight.
  readonly property string _path: "M 26 13 a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0 " +
    "M 32 19 L 19 45 c -3.5 -1 -6 -4 -6 -8.5 " +
    "M 32 19 l 13 26 c 3.5 -1 6 -4 6 -8.5 " +
    "M 22.5 36 h 19"

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

      PathSvg { path: root._path }
    }
  }
}

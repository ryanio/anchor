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
// There is one drawing at every size — the ring, the two branches off it, the crossbar. It used to
// be two, a full anchor with flukes plus a cropped variant for the bar, and two marks for one
// product is a cost with no payer: the bar showed one thing and the site showed another.
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
  readonly property real _x0: 14
  readonly property real _x1: 50
  readonly property real _y0: 7
  readonly property real _y1: 43

  // Inflated by half a stroke so the outer edge of the stroke is what gets fitted rather than the
  // centreline — otherwise the mark is clipped by exactly half a stroke.
  readonly property real _pad: strokeUnits / 2
  readonly property real _left: _x0 - _pad
  readonly property real _top: _y0 - _pad
  readonly property real _w: (_x1 + _pad) - _left
  readonly property real _h: (_y1 + _pad) - _top

  readonly property real _scale: Math.min(iconSize / _w, iconSize / _h)

  // ring · branch left · branch right · crossbar
  readonly property string _path: "M 25.5 13.5 a 6.5 6.5 0 1 0 13 0 a 6.5 6.5 0 1 0 -13 0 " +
    "M 32 20 L 14 43 " +
    "M 32 20 l 18 23 " +
    "M 21.5 36 h 21"

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

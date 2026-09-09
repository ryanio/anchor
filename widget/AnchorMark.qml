import QtQuick
import QtQuick.Shapes

// Anchor's mark, drawn rather than loaded.
//
// The geometry is `site/brand/`'s verbatim, on its 64-unit grid — an anchor that reads as an A. It
// is redrawn here instead of shipped as an asset for the reason the brand README gives for inlining
// the SVG on the site: the mark carries no colour of its own and takes its context's. `color` is
// bound to the bar's foreground by the caller, so the mark follows whichever Omarchy theme is
// applied, live, with no per-theme asset and no recolouring step.
//
// The one thing that is *not* taken from the SVG is the framing. The artwork does not fill its
// viewBox, so scaling the viewBox to a bar slot renders a small mark surrounded by padding, with
// strokes thick enough to close up the ring. Fitting the artwork's own bounds instead makes the mark
// as large as the slot allows, which is what lets the ring stay open at bar size.
Item {
  id: root

  property real iconSize: 16
  property color color: "white"

  /**
   * Draw the square variant (`site/brand/anchor-bar.svg`) instead of the full mark.
   *
   * Two things go wrong with the full mark at bar size, and they need different fixes.
   *
   * **Shape.** It is 32 wide by 45 tall on the 64-unit grid — aspect 0.71 — which is right with room
   * around it and wrong in a row of square glyphs, where it measured 10×12 against neighbours
   * drawing 9–11 square. Shrinking it could never have fixed that: scaling preserves aspect ratio.
   *
   * **Weight.** Fitted to an 11px slot the full mark's stroke computes to 0.93 device pixels. Under
   * one, so it antialiases to grey — not styled thin, starved. No geometry or size change fixes
   * that either; only *fewer elements*, which buys the room for a heavier stroke.
   *
   * So the square variant is the top of the anchor — the ring and the branches off it, flukes
   * cropped — on square bounds of 36×36 at stroke 6. That draws 1.57 device pixels at bar size,
   * and fills the slot in both directions.
   *
   * What it costs, stated because it was a choice and not an oversight: without the flukes this
   * reads as a monogram rather than an anchor. That is the trade a 16px glyph is worth making, and
   * it is why the full mark remains the logo everywhere it has room.
   *
   * Set this anywhere the mark sits in a row of icons at 16px or less. Leave it off elsewhere.
   */
  property bool compact: false

  /**
   * Stroke weight in the artwork's own 64-unit grid.
   *
   * Each variant carries its own, because they are solving opposite problems.
   *
   * The full mark is fitted to its artwork bounds, which enlarges the stroke along with everything
   * else: side by side, 4.5 and above close the ring into a dot and it stops reading as an anchor,
   * while 3.5 keeps it open at every size. The square variant has four elements instead of six, so
   * it can afford 6 — and needs it, because that is what puts the stroke above one device pixel at
   * bar size.
   *
   * Callers drawing the full mark large — the panel hero — pass the brand's own weight instead.
   */
  property real strokeUnits: compact ? 6 : 3.5

  implicitWidth: iconSize
  implicitHeight: iconSize
  width: iconSize
  height: iconSize

  // Path centreline bounds of whichever variant is drawn, straight off the SVG.
  readonly property real _x0: compact ? 14 : 16
  readonly property real _x1: compact ? 50 : 48
  readonly property real _y0: compact ? 7 : 5
  readonly property real _y1: compact ? 43 : 50

  // Inflated by half a stroke so the outer edge of the stroke is what gets fitted rather than the
  // centreline — otherwise the mark is clipped by exactly half a stroke.
  readonly property real _pad: strokeUnits / 2
  readonly property real _left: _x0 - _pad
  readonly property real _top: _y0 - _pad
  readonly property real _w: (_x1 + _pad) - _left
  readonly property real _h: (_y1 + _pad) - _top

  readonly property real _scale: Math.min(iconSize / _w, iconSize / _h)

  // Square variant: ring · branch left · branch right · crossbar.
  // Full mark: ring · shank left · shank right · crossbar · fluke left · fluke right.
  readonly property string _path: compact
    ? "M 25.5 13.5 a 6.5 6.5 0 1 0 13 0 a 6.5 6.5 0 1 0 -13 0 " +
      "M 32 20 L 14 43 " +
      "M 32 20 l 18 23 " +
      "M 21.5 36 h 21"
    : "M 27 10 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0 " +
      "M 32 15 L 21 50 " +
      "M 32 15 l 11 35 " +
      "M 25 34 h 14 " +
      "M 21 50 c -3 -1 -5 -4 -5 -8 " +
      "M 43 50 c 3 -1 5 -4 5 -8"

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

import QtQuick
import Quickshell
import qs.Commons
import "states.js" as States
import "PulseModel.js" as Model

// A photograph of every state the panel can be in.
//
// `PanelContent.qml` renders from one `reading` object and takes no action of its own, so it can be
// mounted here with the signals unconnected and no service, no bar and no desktop behind it. That is
// the whole reason it was split out of `Pulse.qml`: a state you can only reach by arranging for the
// condition on a live machine is a state nobody ever reviews, which is how a widget ends up with
// error screens that have never been looked at.
//
// Run it through `scripts/panel-states.ts`, which builds the import root this needs. Quickshell
// resolves `qs.Commons` and `qs.Ui` relative to the config root, so the script assembles a
// directory of symlinks rather than putting a copy of Omarchy's shell in this repository.
//
// One case is drawn at a time and grabbed before the next is bound. Binding all fifteen at once
// renders them all every frame, and QML's asynchronous image grab then races the next binding —
// the shots come out mislabelled, which is worse than slow.
ShellRoot {
  id: harness

  readonly property var cases: States.CASES
  readonly property string outDir: Quickshell.env("ANCHOR_GALLERY_OUT") || "/tmp/anchor-gallery"
  property int index: 0
  property bool grabbing: false

  FloatingWindow {
    id: win
    visible: true
    implicitWidth: card.width
    implicitHeight: card.height
    color: panel.panelGround

    // Nothing here is sized from the window. A FloatingWindow is a real window and the compositor
    // owns its geometry — Hyprland tiles it to whatever the workspace has spare, which the first
    // run of this made 1892px wide. The shot has to be the panel's size, not the window's.
    Rectangle {
      id: card
      color: panel.panelGround
      // The real panel is 360 wide with 14 of padding, in `Style.space` units so it follows the
      // user's font size the way the live one does rather than being 360 physical pixels here.
      readonly property int pad: Style.space(14)
      width: Style.space(360) + pad * 2
      height: panel.implicitHeight + pad * 2

      PanelContent {
        id: panel
        x: card.pad
        y: card.pad
        width: Style.space(360)

        readonly property var currentCase: harness.cases[harness.index]

        reading: currentCase.reading
        config: Model.mergeSettings(currentCase.settings || {})
        // Fixed, not `Date.now()`: a countdown that moves between two runs makes every shot differ
        // and fills the review page with diffs that are only the clock.
        nowMs: States.NOW
        detailsOpen: (currentCase.view && currentCase.view.detailsOpen) === true
        optionalOpen: (currentCase.view && currentCase.view.optionalOpen) === true
        // Nothing to animate towards in a still.
        animate: false
      }
    }

    // Layout settles a frame or two after a binding changes, and a grab before that catches the
    // previous case's height. One tick of slack per case is cheap; a mislabelled shot is not.
    Timer {
      id: tick
      interval: 320
      running: true
      repeat: true
      onTriggered: {
        if (harness.grabbing) return
        harness.grabbing = true
        const id = harness.cases[harness.index].id
        card.grabToImage(function (result) {
          const ok = result.saveToFile(harness.outDir + "/" + id + ".png")
          console.log(ok ? "captured " + id : "FAILED " + id)
          if (harness.index + 1 >= harness.cases.length) {
            tick.running = false
            Qt.quit()
            return
          }
          harness.index += 1
          harness.grabbing = false
        }, Qt.size(card.width, card.height))
      }
    }
  }
}

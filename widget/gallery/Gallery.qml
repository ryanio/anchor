import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
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

  // Panels first, then bar items. One list, so the harness advances through both without knowing
  // which is which beyond the size of the frame it grabs.
  readonly property var cases: {
    const all = []
    for (const c of States.CASES) all.push(Object.assign({ kind: "panel" }, c))
    for (const c of States.BAR_CASES) all.push(Object.assign({ kind: "bar" }, c))
    return all
  }
  readonly property var currentCase: cases[index]
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
      color: harness.currentCase.kind === "bar" ? "#16181d" : panel.panelGround
      readonly property int pad: Style.space(14)
      width: harness.currentCase.kind === "bar" ? Style.space(300) : Style.space(360) + pad * 2
      height: harness.currentCase.kind === "bar" ? barStrip.height : panel.implicitHeight + pad * 2

      // The bar's own ground and the bar's own height, because a bar item reviewed on a card
      // background is a bar item reviewed in a place it never is.
      Item {
        id: barStrip
        anchors.horizontalCenter: parent.horizontalCenter
        width: parent.width
        height: Style.bar.height > 0 ? Style.bar.height : Style.space(26)
        visible: harness.currentCase.kind === "bar"

        BarItem {
          anchors.centerIn: parent
          reading: harness.currentCase.reading
          config: Model.mergeSettings(harness.currentCase.settings || {})
          nowMs: States.NOW
          vertical: harness.currentCase.vertical === true
          foreground: "#e6e9ef"
          urgent: Color.urgent
          // The live widget derives these from the theme's contrast; here they are the values that
          // derivation lands on for a dark bar, so a review sees the dim it actually ships.
          dim: Qt.rgba(0.902, 0.914, 0.937, 0.55)
          dimOpacity: 0.55
        }
      }

      PanelContent {
        id: panel
        x: card.pad
        y: card.pad
        width: Style.space(360)
        visible: harness.currentCase.kind === "panel"

        reading: harness.currentCase.reading
        config: Model.mergeSettings(harness.currentCase.settings || {})
        // Fixed, not `Date.now()`: a countdown that moves between two runs makes every shot differ
        // and fills the review page with diffs that are only the clock.
        nowMs: States.NOW
        detailsOpen: (harness.currentCase.view && harness.currentCase.view.detailsOpen) === true
        optionalOpen: (harness.currentCase.view && harness.currentCase.view.optionalOpen) === true
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
        const c = harness.cases[harness.index]
        const sub = c.kind === "bar" ? "bar/" : "panel/"
        const id = c.id
        card.grabToImage(function (result) {
          const ok = result.saveToFile(harness.outDir + "/" + sub + id + ".png")
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

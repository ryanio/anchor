import QtQuick
import Quickshell
import Quickshell.Io
import "PulseModel.js" as Model

// The active Omarchy theme's surface layers, read at runtime.
//
// The shell's `Color` singleton already parses `colors.toml`, but keeps only five values —
// foreground, background, accent, urgent, muted. The layers a panel needs to have any depth
// (`lighter_background`, `dark_background`, `selection`) never reach QML, which is why the panel
// shipped flat: everything it drew was the one background it could see.
//
// So this reads the same file for those three keys and nothing else, and hands them to
// `Model.panelSurfaces`, which decides whether the theme's own value is a usable step off the
// ground the panel is actually painted on or whether one has to be derived. Nothing here is an
// Anchor colour: a widget that painted itself ocean-cyan on a Rose Pine desktop would look like a
// bug, and that applies to its surfaces as much as to its text.
//
// **This is where a future theme provider plugs in.** When a chosen NFT re-themes the desktop, the
// honest place for it is `colors.toml` — recolour the Omarchy theme and every app on the machine
// follows, this widget included, with nothing here to change. Failing that, one more source merged
// into `themeColors` below reaches every colour the widget draws, because none of them is a
// literal at a call site.
Item {
  id: root

  /** The surface the panel is actually painted on. The layers are derived relative to this. */
  property color ground: "#101315"

  /** Parsed `colors.toml`. Replaced wholesale so the bindings below re-evaluate; see Color.qml. */
  property var themeColors: ({})

  readonly property var surfaces: Model.panelSurfaces(
    { r: root.ground.r, g: root.ground.g, b: root.ground.b }, root.themeColors)

  readonly property color raised: Qt.rgba(surfaces.raised.r, surfaces.raised.g, surfaces.raised.b, 1)
  readonly property color sunken: Qt.rgba(surfaces.sunken.r, surfaces.sunken.g, surfaces.sunken.b, 1)
  readonly property color line: Qt.rgba(surfaces.line.r, surfaces.line.g, surfaces.line.b, 1)
  readonly property bool light: themeColors.mode === "light"

  readonly property string themePath:
    (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state"))
    + "/omarchy/current/theme/colors.toml"

  function reload() { colors.reload() }

  FileView {
    id: colors
    path: root.themePath
    // `omarchy theme set` rewrites this directory in place. Watching catches most switches; the
    // owner also reloads when the panel opens, because the shell's own theme reload arrives over
    // IPC rather than through the filesystem and this file is not on that path.
    watchChanges: true
    // A machine with no Omarchy theme applied is not an error — `panelSurfaces` derives every layer
    // from the ground when the file yields nothing, which is exactly the empty-object case.
    printErrors: false
    onLoaded: root.themeColors = Model.parseThemeColors(text())
    onFileChanged: reload()
    onLoadFailed: root.themeColors = ({})
  }

  Component.onCompleted: colors.reload()
}

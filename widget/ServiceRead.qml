import QtQuick
import Quickshell.Io
import "PulseModel.js" as Model

// One polled read from Anchor's local data service.
//
// Every fetch is a detached `curl` rather than an XMLHttpRequest, which is the idiom the first-party
// weather plugin already uses and, more importantly, the only one that cannot block: this component
// runs inside `omarchy-shell`, the single process that draws the whole desktop, so a synchronous
// request here would freeze the bar, the notifications and every panel at once.
//
// The contract with the owner is a single `finished(response)` signal that fires exactly once per
// cycle whatever happens — success, HTTP refusal, connection refused, timeout, or a curl that could
// not be spawned at all. A read that silently never completes would leave the widget showing an old
// number with no way to know it had stopped updating, which is the failure this whole widget exists
// to avoid.
Item {
  id: root

  /** Path on the service, e.g. "/portfolio/value". Never a full URL — the host is not configurable. */
  property string path: ""
  property var settings: ({})
  /** Milliseconds between polls. Should sit at or above the service's TTL for this resource. */
  property int interval: 60000
  /** Milliseconds to wait before the first poll, so four reads do not start as one burst. */
  property int startDelay: 0
  property bool active: true

  signal finished(var response)

  property bool _pending: false

  function refresh() {
    if (!root.active || root.path === "" || proc.running) return
    root._pending = true
    proc.command = Model.curlArgs(root.path, root.settings)
    proc.running = true
  }

  function _deliver(response) {
    if (!root._pending) return
    root._pending = false
    root.finished(response)
  }

  Process {
    id: proc

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root._deliver(Model.parseResponse(text))
    }

    // stderr is collected and dropped rather than left unattached. curl -sS writes its diagnosis
    // there, and that text can quote a URL or a header; nothing in this widget renders it, and an
    // unattached stream would leak it into the shell's own log instead.
    stderr: StdioCollector { waitForEnd: true }

    // Covers the cases the stdout stream cannot: curl missing from PATH, a kill, or an exit with
    // nothing written. `_pending` makes this idempotent with onStreamFinished.
    onExited: root._deliver({ ok: false, status: 0, data: null, meta: null, error: "no response" })
  }

  Timer {
    id: firstPoll
    interval: Math.max(0, root.startDelay)
    repeat: false
    running: root.active
    onTriggered: root.refresh()
  }

  Timer {
    interval: Math.max(5000, root.interval)
    repeat: true
    running: root.active && !firstPoll.running
    onTriggered: root.refresh()
  }

  // A shell that has been suspended and resumed, or one whose widget was just re-enabled, should
  // not sit out the rest of an interval showing data from before the gap.
  onActiveChanged: if (root.active) root.refresh()

  Component.onDestruction: if (proc.running) proc.signal(9)
}

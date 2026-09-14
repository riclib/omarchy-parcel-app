import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Detail popup for the Parcel bar widget. Owns the data lifecycle (fetch,
// cache-aware refresh, status-change notifications) and the keyboard-driven
// list of deliveries. All network access goes through bin/parcel-api.
Panel {
  id: root
  moduleName: "io.github.zuccs.parcel"
  ipcTarget: "io.github.zuccs.parcel"
  manageIpc: false

  property var anchorItem: null
  property bool openedFromHotkey: false

  // The bar tracks the widget mounted in its slot (BarWidget.qml), not this
  // nested panel, so everything the bar identifies a panel by has to be that
  // widget. Same arrangement as the first-party Weather panel.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
    root.refresh(false)
  }

  function openFromHotkey() {
    openedFromHotkey = true
    root.controller.show()
    root.refresh(false)
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    try {
      setCenterHoverRevealSuppressed(false)
    } finally {
      root.controller.hide()
    }
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  // ---- Settings (inline on this widget's shell.json entry) -----------------

  // Parcel allows 20 deliveries requests per hour; 300 s is the floor so a
  // manual refresh or two never tips it over.
  readonly property int refreshIntervalSec: Math.max(300, parseInt(setting("refreshIntervalSec", 600), 10) || 600)
  readonly property string filterMode: String(setting("filterMode", "active")) === "recent" ? "recent" : "active"
  readonly property bool notificationsEnabled: String(setting("notifications", "On")) !== "Off"

  onFilterModeChanged: refresh(false)

  // ---- State ----------------------------------------------------------------

  // Absolute path of the bridge script, wherever this plugin was installed.
  readonly property string scriptPath: String(Qt.resolvedUrl("bin/parcel-api")).replace(/^file:\/\//, "")

  property var carriers: ({})
  property string lastRaw: ""
  property var deliveries: []
  property string errorCode: ""
  property string errorMessage: ""
  property bool stale: false
  property double fetchedAt: 0
  property bool refreshing: false
  property bool everLoaded: false
  property int cursor: 0
  property int expandedIndex: -1
  property var now: new Date()

  readonly property int activeCount: Model.activeDeliveries(deliveries).length
  readonly property string badgeText: Model.badgeText(deliveries)
  readonly property bool badgeUrgent: Model.badgeUrgent(deliveries)
  readonly property bool needsSetup: errorCode === "no-key"
  readonly property bool showingError: !needsSetup && errorCode !== "" && !stale
  readonly property string headline: needsSetup ? "API key needed"
    : (showingError && deliveries.length === 0 ? "Unavailable"
    : (!everLoaded ? "Fetching deliveries…" : Model.summaryLine(deliveries)))
  readonly property string tooltip: needsSetup ? "Parcel · API key not set"
    : (showingError && deliveries.length === 0 ? "Parcel · " + errorMessage : Model.summaryLine(deliveries))
  readonly property string updatedText: {
    root.now // reactive dependency so relative times tick
    if (!root.fetchedAt) return ""
    var rel = Model.formatRelative(new Date(root.fetchedAt), root.now)
    if (root.stale) return (root.errorMessage || "Last refresh failed") + " — showing data from " + rel
    return "Updated " + rel
  }

  // Popup text sits on the popup background, so use the theme foreground (as
  // Weather does), not barForeground, which swaps to a contrast colour when the
  // bar itself is transparent.
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property color urgent: bar && bar.urgent !== undefined ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // ---- Data lifecycle -------------------------------------------------------

  // force=false honours the on-disk cache (a panel open or shell restart costs
  // no API request); force=true always hits the API.
  property bool pendingRefresh: false
  property bool pendingForce: false

  function refresh(force) {
    if (fetchProc.running) {
      // Settings can change (or a hotkey fire) mid-fetch; run again when done.
      pendingRefresh = true
      pendingForce = pendingForce || force === true
      return
    }
    refreshing = true
    var maxAge = force ? "0" : String(Math.max(60, refreshIntervalSec - 30))
    fetchProc.command = [root.scriptPath, "deliveries", root.filterMode, "--max-age", maxAge]
    fetchProc.running = true
  }

  onRefreshingChanged: if (!refreshing) refreshButton.rotation = 0

  function applyRaw(raw) {
    var parsed = Model.parseResponse(raw, root.carriers)
    // A response for the previous filter mode (settings changed mid-fetch)
    // must not be shown under the new one; fetch the right one instead.
    if (parsed.ok && parsed.mode && parsed.mode !== root.filterMode) {
      root.pendingRefresh = true // onExited runs the queued refresh once
      return
    }
    root.lastRaw = raw
    if (parsed.ok) {
      if (root.everLoaded && root.notificationsEnabled && !parsed.cached)
        root.notify(Model.diffStatuses(root.deliveries, parsed.deliveries))
      root.deliveries = parsed.deliveries
      root.fetchedAt = parsed.fetchedAt
      root.stale = parsed.stale
      root.errorCode = parsed.stale ? parsed.error : ""
      root.errorMessage = parsed.stale ? parsed.message : ""
      root.everLoaded = true
    } else {
      root.errorCode = parsed.error || "unknown"
      root.errorMessage = parsed.message || "Something went wrong."
      // Keep whatever we last showed, but say so: a failed poll must not
      // present old data as current.
      root.stale = root.deliveries.length > 0
    }
    if (root.cursor >= root.deliveries.length) root.cursor = Math.max(0, root.deliveries.length - 1)
    if (root.expandedIndex >= root.deliveries.length) root.expandedIndex = -1
    root.now = new Date()
  }

  // One bar surface exists per monitor, each with its own panel instance.
  // Route explicit refreshes through the host widget so every instance
  // updates; the bridge's lock makes that a single API request.
  function refreshAll() {
    if (root.hostWidget && typeof root.hostWidget.broadcast === "function") root.hostWidget.broadcast("refresh")
    else root.refresh(true)
  }

  function notify(changes) {
    for (var i = 0; i < changes.length; i++) {
      var n = Model.notificationFor(changes[i])
      Quickshell.execDetached(["omarchy-notification-send", "--app-name", "Parcel", "-g", n.glyph, "-u", n.urgency, n.headline, n.body])
    }
  }

  function moveCursor(delta) {
    if (!root.deliveries.length) return
    root.cursor = Math.max(0, Math.min(root.deliveries.length - 1, root.cursor + delta))
    ensureCursorVisible()
  }

  function activateCursor() {
    if (!root.deliveries.length) return
    root.expandedIndex = root.expandedIndex === root.cursor ? -1 : root.cursor
    Qt.callLater(ensureCursorVisible)
  }

  function ensureCursorVisible() {
    var item = rowRepeater.itemAt(root.cursor)
    if (!item) return
    if (item.y < listFlick.contentY) listFlick.contentY = item.y
    else if (item.y + item.height > listFlick.contentY + listFlick.height)
      listFlick.contentY = Math.max(0, item.y + item.height - listFlick.height)
  }

  function copyTracking() {
    var d = root.deliveries[root.cursor]
    if (!d || !d.trackingNumber) return
    Quickshell.execDetached(["wl-copy", d.trackingNumber])
    Quickshell.execDetached(["omarchy-notification-send", "--app-name", "Parcel", "-g", "󰆏", "Tracking number copied", d.description])
  }

  function copySetupCommand() {
    Quickshell.execDetached(["wl-copy", Model.SETUP_COMMAND])
    Quickshell.execDetached(["omarchy-notification-send", "--app-name", "Parcel", "-g", "󰌆", "Command copied", "Paste it in a terminal, then press r in the panel"])
  }

  function openWeb() {
    Quickshell.execDetached(["omarchy-launch-webapp", "https://web.parcelapp.net"])
  }

  Process {
    id: fetchProc
    running: false
    command: []
    stdout: StdioCollector { id: fetchStdout; waitForEnd: true; onStreamFinished: root._fetchOutput = text }
    onExited: function(exitCode) {
      root.refreshing = false
      var raw = String(fetchStdout.text || root._fetchOutput || "").trim()
      root._fetchOutput = ""
      if (!raw) {
        root.errorCode = "bridge"
        root.errorMessage = "parcel-api produced no output (exit " + exitCode + "). Is it executable?"
        root.stale = root.deliveries.length > 0
      } else {
        root.applyRaw(raw)
      }
      if (root.pendingRefresh) {
        var force = root.pendingForce
        root.pendingRefresh = false
        root.pendingForce = false
        Qt.callLater(function() { root.refresh(force) })
      }
    }
  }
  property string _fetchOutput: ""

  // Carrier code → name map, via the bridge so `parcel-api carriers --refresh`
  // (state cache) takes precedence over the bundled data/carriers.json.
  Process {
    id: carriersProc
    running: false
    command: [root.scriptPath, "carriers"]
    stdout: StdioCollector { id: carriersStdout; waitForEnd: true; onStreamFinished: root._carriersOutput = text }
    onExited: function(exitCode) {
      var raw = String(carriersStdout.text || root._carriersOutput || "")
      root._carriersOutput = ""
      var parsed = Model.parseCarriers(raw)
      if (Object.keys(parsed).length === 0) return
      root.carriers = parsed
      // Deliveries fetched before the carrier list arrived carry bare codes;
      // re-parse the last response so names appear.
      if (root.lastRaw) root.applyRaw(root.lastRaw)
    }
  }
  property string _carriersOutput: ""
  Component.onCompleted: carriersProc.running = true

  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh(false)
  }

  // Relative timestamps tick while the panel is open.
  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.now = new Date()
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.refreshAll() }
  }

  // ---- UI -------------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r") root.refreshAll()
        else if (t === "y" || t === "c") root.copyTracking()
        else if (t === "o") root.openWeb()
      }

      Column {
        id: contentColumn
        width: parent.width
        spacing: Style.space(10)

        // ---- Header: glyph, title, one-line summary, refresh.
        Item {
          width: parent.width
          height: Math.max(headerLeft.implicitHeight, refreshButton.height)

          Row {
            id: headerLeft
            anchors.left: parent.left
            anchors.right: refreshButton.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(12)

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: Model.BAR_GLYPH
              color: root.badgeUrgent ? root.urgent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }

            Column {
              anchors.verticalCenter: parent.verticalCenter
              width: headerLeft.width - Style.font.display - headerLeft.spacing
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                text: "PARCEL"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.letterSpacing: 1
              }
              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.headline
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                elide: Text.ElideRight
              }
            }
          }

          PanelActionButton {
            id: refreshButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰑐"
            tooltipText: "Refresh (r)"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: !root.refreshing && !root.needsSetup
            onClicked: root.refreshAll()

            RotationAnimator on rotation {
              running: root.refreshing
              from: 0; to: 360
              duration: 900
              loops: Animation.Infinite
            }
          }
        }

        PanelSeparator {
          width: parent.width
          foreground: root.foreground
        }

        // ---- Setup: no API key in the keyring yet.
        Column {
          visible: root.needsSetup
          width: parent.width
          spacing: Style.space(8)

          Text {
            textFormat: Text.PlainText
            width: parent.width
            wrapMode: Text.WordWrap
            text: "This widget reads the deliveries you track in the Parcel app through its Premium API. Create an API key at web.parcelapp.net, then store it in your keyring:"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          Rectangle {
            width: parent.width
            height: setupCommand.implicitHeight + Style.space(16)
            radius: Style.cornerRadius
            color: Style.normalFillFor(root.foreground, Color.accent)

            Text {
              id: setupCommand
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.margins: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: Model.SETUP_COMMAND
              wrapMode: Text.WrapAnywhere
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }

          Row {
            spacing: Style.space(8)

            Button {
              text: "Copy command"
              iconText: "󰆏"
              foreground: root.foreground
              fontFamily: root.fontFamily
              bordered: true
              onClicked: root.copySetupCommand()
            }
            Button {
              text: "Open web.parcelapp.net"
              iconText: "󰏌"
              foreground: root.foreground
              fontFamily: root.fontFamily
              bordered: true
              onClicked: root.openWeb()
            }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            wrapMode: Text.WordWrap
            text: "secret-tool prompts for the key so it never touches your shell history. Press r here once it is stored."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        // ---- Error with nothing cached to show.
        Text {
          textFormat: Text.PlainText
          visible: root.showingError && root.deliveries.length === 0
          width: parent.width
          wrapMode: Text.WordWrap
          text: root.errorMessage
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }

        // ---- Empty.
        Text {
          textFormat: Text.PlainText
          visible: !root.needsSetup && !root.showingError && root.everLoaded && root.deliveries.length === 0
          text: root.filterMode === "recent" ? "Nothing tracked recently." : "Nothing on the way right now."
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.italic: true
        }

        // ---- Deliveries.
        Flickable {
          id: listFlick
          visible: root.deliveries.length > 0
          width: parent.width
          height: Math.min(rowsColumn.implicitHeight, Style.space(460))
          contentWidth: width
          contentHeight: rowsColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height

          Column {
            id: rowsColumn
            width: listFlick.width
            spacing: Style.space(2)

            Repeater {
              id: rowRepeater
              model: root.deliveries

              delegate: Rectangle {
                id: row
                required property var modelData
                required property int index

                readonly property bool hasCursor: index === root.cursor
                readonly property bool expanded: index === root.expandedIndex
                readonly property color statusColor: modelData.tone === "urgent" ? root.urgent
                  : (modelData.tone === "muted" ? root.dim : root.foreground)
                readonly property string eta: {
                  root.now
                  return Model.formatEta(modelData, root.now)
                }

                width: rowsColumn.width
                height: rowContent.implicitHeight + Style.space(14)
                radius: Style.cornerRadius
                color: hasCursor ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"

                Column {
                  id: rowContent
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.leftMargin: Style.space(10)
                  anchors.rightMargin: Style.space(10)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(8)

                  Row {
                    id: mainRow
                    width: parent.width
                    spacing: Style.space(10)

                    Text {
                      id: statusGlyph
                      textFormat: Text.PlainText
                      width: Style.space(22)
                      anchors.verticalCenter: parent.verticalCenter
                      text: row.modelData.glyph
                      color: row.statusColor
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.iconLarge
                      horizontalAlignment: Text.AlignHCenter
                    }

                    Column {
                      width: mainRow.width - statusGlyph.width - etaColumn.width - mainRow.spacing * 2
                      anchors.verticalCenter: parent.verticalCenter
                      spacing: Style.space(2)

                      Text {
                        textFormat: Text.PlainText
                        width: parent.width
                        text: row.modelData.description
                        color: row.modelData.tone === "muted" ? root.dim : root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                        elide: Text.ElideRight
                      }
                      Text {
                        textFormat: Text.PlainText
                        width: parent.width
                        text: row.modelData.carrierName
                          + (row.modelData.latestEvent && row.modelData.latestEvent.event ? " · " + row.modelData.latestEvent.event : "")
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        elide: Text.ElideRight
                      }
                    }

                    Column {
                      id: etaColumn
                      width: Math.max(etaText.implicitWidth, statusText.implicitWidth)
                      anchors.verticalCenter: parent.verticalCenter
                      spacing: Style.space(2)

                      Text {
                        id: etaText
                        textFormat: Text.PlainText
                        width: parent.width
                        text: row.eta
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        horizontalAlignment: Text.AlignRight
                      }
                      Text {
                        id: statusText
                        textFormat: Text.PlainText
                        width: parent.width
                        text: row.modelData.status.toUpperCase()
                        color: row.statusColor
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.letterSpacing: 1
                        horizontalAlignment: Text.AlignRight
                      }
                    }
                  }

                  // ---- Expanded: checkpoint timeline + tracking number.
                  Column {
                    visible: row.expanded
                    width: parent.width
                    spacing: Style.space(4)

                    Repeater {
                      model: row.expanded ? row.modelData.events.slice(0, 6) : []

                      delegate: Row {
                        id: eventRow
                        required property var modelData
                        width: parent.width
                        spacing: Style.space(10)

                        Text {
                          id: eventTime
                          textFormat: Text.PlainText
                          width: Style.space(112)
                          text: Model.formatEventTime(eventRow.modelData.date, root.now)
                          color: root.dim
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                        }
                        Text {
                          textFormat: Text.PlainText
                          width: eventRow.width - eventTime.width - eventRow.spacing
                          text: eventRow.modelData.event
                            + (eventRow.modelData.location ? " — " + eventRow.modelData.location : "")
                          color: root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.bodySmall
                          wrapMode: Text.WordWrap
                        }
                      }
                    }

                    Text {
                      textFormat: Text.PlainText
                      visible: row.modelData.events.length === 0
                      text: "No checkpoints yet."
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.italic: true
                    }

                    Text {
                      textFormat: Text.PlainText
                      width: parent.width
                      text: (row.modelData.trackingNumber ? row.modelData.trackingNumber + " · " : "")
                        + row.modelData.carrierName + "  ·  y to copy tracking number"
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                    }
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onPositionChanged: root.cursor = row.index
                  onClicked: {
                    root.cursor = row.index
                    root.activateCursor()
                  }
                }
              }
            }
          }
        }

        // ---- Footer: freshness + key hints.
        Column {
          width: parent.width
          spacing: Style.space(2)
          visible: root.everLoaded || root.stale

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: root.updatedText
            color: root.stale ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: "↑↓ select · ⏎ details · y copy · r refresh · o open Parcel"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }
      }
    }
  }
}

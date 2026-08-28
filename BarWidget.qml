import QtQuick
import qs.Commons
import qs.Ui

// Bar entry point. Mirrors the first-party Weather widget: the bar mounts
// this item, and it hosts Panel.qml through a Loader so the panel gets the
// same `bar` / `settings` the bar hands us. The open/close/opened trio and
// closeForPopoutSwitch are what let `omarchy-shell shell toggle <id>` and
// the bar's single-popout coordinator treat this widget as the panel.
BarWidget {
  id: root
  moduleName: "io.github.zuccs.parcel"

  readonly property var panel: panelLoader.item
  readonly property int activeCount: panel ? panel.activeCount : 0
  readonly property bool hideWhenEmpty: String(setting("hideWhenEmpty", "Off")) === "On"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function refresh() {
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh(true)
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract for shell.summon/hide/toggle routing (Bar.findPanelWidget
  // requires open/close/opened on the bar-widget root).
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  visible: panel !== null && !(hideWhenEmpty && activeCount === 0 && panel.errorCode === "")
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.panel ? root.panel.badgeText : ""
    // Urgent (bar "active" colour) when the lead parcel wants attention:
    // out for delivery, failed attempt, exception.
    active: root.panel ? root.panel.badgeUrgent : false
    dimmed: root.panel ? (root.activeCount === 0 && root.panel.errorCode === "") : true
    tooltipText: root.panel ? root.panel.tooltip : "Parcel"

    onPressed: function(b) {
      if (b === Qt.RightButton) {
        if (root.bar) root.bar.run("omarchy-launch-webapp https://web.parcelapp.net")
      } else if (b === Qt.MiddleButton) {
        root.broadcast("refresh")
      } else {
        root.togglePanel()
      }
    }
  }
}

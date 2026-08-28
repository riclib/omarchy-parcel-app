// Pure functions for the Parcel widget. No QML types in here so the whole file
// runs under `node --test test/` as well as inside the shell.
//
// Input is the JSON printed by bin/parcel-api; output is plain objects the QML
// binds to directly.

// Parcel's status_code values, from https://parcelapp.net/help/api-view-deliveries.html
// rank: higher means "needs your attention more" — drives sort order and the
// badge state. tone: "urgent" tints the bar icon, "muted" dims a row.
var STATUS = {
  0: { code: 0, label: "Delivered",           glyph: "󰗠", rank: 10, tone: "muted"  }, // md-check_circle
  1: { code: 1, label: "Frozen",              glyph: "󰜗", rank: 20, tone: "muted"  }, // md-snowflake
  2: { code: 2, label: "In transit",          glyph: "󰔽", rank: 50, tone: "normal" }, // md-truck
  3: { code: 3, label: "Ready for pickup",    glyph: "󰓜", rank: 70, tone: "normal" }, // md-store
  4: { code: 4, label: "Out for delivery",    glyph: "󰔾", rank: 90, tone: "urgent" }, // md-truck_delivery
  5: { code: 5, label: "Not found",           glyph: "󰋗", rank: 30, tone: "muted"  }, // md-help_circle
  6: { code: 6, label: "Failed attempt",      glyph: "󰀦", rank: 85, tone: "urgent" }, // md-alert
  7: { code: 7, label: "Exception",           glyph: "󰀨", rank: 80, tone: "urgent" }, // md-alert_circle
  8: { code: 8, label: "Received by carrier", glyph: "󰏗", rank: 40, tone: "normal" }  // md-package_variant_closed
}

var UNKNOWN_STATUS = { code: -1, label: "Unknown", glyph: "󰋗", rank: 0, tone: "muted" }

var BAR_GLYPH = "󰏓" // md-package

function statusFor(code) {
  var n = parseInt(code, 10)
  return STATUS.hasOwnProperty(n) ? STATUS[n] : UNKNOWN_STATUS
}

// Everything below this line that touches `raw` is treating Parcel's response
// as untrusted input: it is relayed from carrier systems, and it lands in QML
// Text items, tooltips and notification arguments.
//
// MAX_TEXT is a display bound, not a security boundary on its own — the bridge
// already caps the bytes that reach us — but it keeps one hostile field from
// turning into a megabyte of text layout, and it stops a wall of text pushing
// the rest of a row off screen.
var MAX_TEXT = 200
var MAX_CODE = 32
var MAX_TRACKING = 64
var MAX_DELIVERIES = 100
var MAX_EVENTS = 50

var CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
var LINE_BREAKS = /[\r\n\t\u2028\u2029]+/g

// One-line, plain, bounded. Angle brackets become their single-angle-quote
// cousins ‹ › — same look, but nothing can parse them as a tag. That matters
// because these strings reach Qt components we do not own (the bar tooltip, a
// notification body) where the text format is theirs to choose, and Qt's
// AutoText treats anything tag-shaped as rich text — which will fetch an
// <img src>. Text items in Panel.qml are pinned to Text.PlainText as well;
// this is the half of that pair that survives leaving our own QML.
function trim(s, limit) {
  var out = String(s === undefined || s === null ? "" : s)
    .replace(CONTROL_CHARS, "")
    .replace(LINE_BREAKS, " ")
    .replace(/</g, "\u2039")
    .replace(/>/g, "\u203A")
    .replace(/^\s+|\s+$/g, "")
  var max = limit || MAX_TEXT
  if (out.length > max) out = out.slice(0, max - 1) + "\u2026"
  return out
}

// "27.08.2026 07:47" (events) or "2026-08-28 10:00:00" (expected) → Date|null.
// Parcel reports times in the account's local zone without an offset; we treat
// them as local, which matches what the phone app shows.
function parseDate(text) {
  var s = trim(text)
  if (!s) return null
  var m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/.exec(s)
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0, 0)
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0, 0)
  var d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function hasClockTime(date) {
  return !!date && (date.getHours() !== 0 || date.getMinutes() !== 0)
}

function pad2(n) { return (n < 10 ? "0" : "") + n }
function clock(date) { return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) }

var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()) }
function dayDiff(a, b) { return Math.round((startOfDay(a) - startOfDay(b)) / 86400000) }

function shortDate(date) { return DAY_NAMES[date.getDay()] + " " + date.getDate() + " " + MONTH_NAMES[date.getMonth()] }

// Carrier map from supported_carriers.json: { "au": { "name": "Australia Post" }, ... }
function parseCarriers(raw) {
  try {
    var data = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!data || typeof data !== "object") return {}
    // bin/parcel-api wrapper: {ok, source, carriers} on success, {ok:false,...} on failure.
    if (data.ok === false) return {}
    if (data.ok === true || data.carriers !== undefined) data = data.carriers
    if (!data || typeof data !== "object") return {}
    var out = {}
    for (var code in data) {
      var entry = data[code]
      var name = entry && typeof entry === "object" ? entry.name : entry
      if (typeof name === "string" && name) {
        var clean = trim(name)
        if (clean) out[trim(code, MAX_CODE)] = clean
      }
    }
    return out
  } catch (e) {
    return {}
  }
}

function carrierName(code, carriers) {
  var c = trim(code, MAX_CODE)
  if (!c) return ""
  // parseCarriers already cleans the map it builds; clean again on the way out
  // so a map handed in from anywhere else cannot smuggle markup through.
  if (carriers && carriers[c]) return trim(carriers[c])
  return c.toUpperCase()
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null
  var date = parseDate(raw.date)
  return {
    event: trim(raw.event),
    location: trim(raw.location),
    additional: trim(raw.additional),
    date: date,
    time: date ? date.getTime() : 0
  }
}

function normalizeDelivery(raw, carriers) {
  if (!raw || typeof raw !== "object") return null
  var status = statusFor(raw.status_code)
  var events = []
  if (Array.isArray(raw.events)) {
    var eventCount = Math.min(raw.events.length, MAX_EVENTS)
    for (var i = 0; i < eventCount; i++) {
      var ev = normalizeEvent(raw.events[i])
      if (ev && (ev.event || ev.location)) events.push(ev)
    }
  }
  // Parcel returns newest first; keep that but don't trust it blindly.
  events.sort(function(a, b) { return b.time - a.time })

  // Prefer the epoch timestamps: Parcel supplies them when the carrier gave a
  // full date, time and zone, and they are unambiguous. The strings carry no
  // offset, so they only serve as the fallback.
  var expectedStart = typeof raw.timestamp_expected === "number" && raw.timestamp_expected > 0
    ? new Date(raw.timestamp_expected * 1000) : parseDate(raw.date_expected)
  var expectedEnd = typeof raw.timestamp_expected_end === "number" && raw.timestamp_expected_end > 0
    ? new Date(raw.timestamp_expected_end * 1000) : parseDate(raw.date_expected_end)

  var carrierCode = trim(raw.carrier_code, MAX_CODE)
  var tracking = trim(raw.tracking_number, MAX_TRACKING)
  return {
    key: carrierCode + ":" + tracking,
    description: trim(raw.description) || tracking || "Untitled delivery",
    carrierCode: carrierCode,
    carrierName: carrierName(carrierCode, carriers),
    trackingNumber: tracking,
    statusCode: status.code,
    status: status.label,
    glyph: status.glyph,
    rank: status.rank,
    tone: status.tone,
    extra: trim(raw.extra_information),
    expectedStart: expectedStart,
    expectedEnd: expectedEnd,
    expectedTime: expectedStart ? expectedStart.getTime() : 0,
    latestEvent: events.length ? events[0] : null,
    events: events
  }
}

function sortDeliveries(list) {
  var out = list.slice()
  out.sort(function(a, b) {
    if (b.rank !== a.rank) return b.rank - a.rank
    var ae = a.expectedTime || Number.MAX_VALUE, be = b.expectedTime || Number.MAX_VALUE
    if (ae !== be) return ae - be
    return a.description.localeCompare(b.description)
  })
  return out
}

// bin/parcel-api output → view model. Never throws.
function parseResponse(raw, carriers) {
  var result = {
    ok: false, error: "", message: "", stale: false, cached: false,
    mode: "", fetchedAt: 0, deliveries: []
  }
  var data
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw
  } catch (e) {
    result.error = "bad-response"
    result.message = "Unreadable response from parcel-api."
    return result
  }
  if (!data || typeof data !== "object") {
    result.error = "bad-response"
    result.message = "Empty response from parcel-api."
    return result
  }
  result.error = trim(data.error, 40)
  result.message = trim(data.message, 300)
  result.stale = data.stale === true
  result.cached = data.cached === true
  result.mode = trim(data.mode)
  result.fetchedAt = typeof data.fetchedAt === "number" ? data.fetchedAt * 1000 : 0
  if (Array.isArray(data.deliveries)) {
    var list = []
    var count = Math.min(data.deliveries.length, MAX_DELIVERIES)
    for (var i = 0; i < count; i++) {
      var d = normalizeDelivery(data.deliveries[i], carriers)
      if (d) list.push(d)
    }
    result.deliveries = sortDeliveries(list)
  } else if (data.ok === true) {
    // The bridge validates this too; a success object with no deliveries
    // array must never read as "nothing on the way".
    result.error = "bad-response"
    result.message = "Response carried no deliveries list."
    return result
  }
  result.ok = data.ok === true
  return result
}

function activeDeliveries(list) {
  return list.filter(function(d) { return d.statusCode !== 0 })
}

function leadDelivery(list) {
  var active = activeDeliveries(list)
  return active.length ? active[0] : (list.length ? list[0] : null)
}

// Bar badge: package glyph, plus the active count when there is one.
function badgeText(list) {
  var n = activeDeliveries(list).length
  return n > 0 ? BAR_GLYPH + " " + n : BAR_GLYPH
}

function badgeUrgent(list) {
  var lead = leadDelivery(list)
  return !!lead && lead.tone === "urgent"
}

function summaryLine(list) {
  var active = activeDeliveries(list)
  if (!active.length) return "No active deliveries"
  var counts = {}
  for (var i = 0; i < active.length; i++) counts[active[i].status] = (counts[active[i].status] || 0) + 1
  // Lead state only: the full breakdown elided in the panel header on a
  // 460px card, and the list below it already shows every state.
  var lead = sortDeliveries(active)[0].status
  var head = active.length + (active.length === 1 ? " delivery" : " deliveries")
  if (active.length === 1) return head + " · " + lead.toLowerCase()
  return head + " · " + counts[lead] + " " + lead.toLowerCase()
}

// "Today", "Today 10:00–14:00", "Tomorrow", "Fri 30 Aug", "Overdue (Mon 24 Aug)"
function formatEta(delivery, now) {
  if (!delivery || !delivery.expectedStart) return ""
  now = now || new Date()
  var start = delivery.expectedStart
  var diff = dayDiff(start, now)
  var day
  if (diff === 0) day = "Today"
  else if (diff === 1) day = "Tomorrow"
  else if (diff < 0) return delivery.statusCode === 0 ? shortDate(start) : "Was due " + shortDate(start)
  else day = shortDate(start)

  var window = ""
  if (hasClockTime(start)) {
    window = clock(start)
    if (delivery.expectedEnd && hasClockTime(delivery.expectedEnd) && delivery.expectedEnd.getTime() !== start.getTime())
      window += "–" + clock(delivery.expectedEnd)
  }
  return window ? day + " " + window : day
}

// "just now", "4m ago", "3h ago", "yesterday 14:02", "Mon 24 Aug"
function formatRelative(date, now) {
  if (!date) return ""
  now = now || new Date()
  var seconds = Math.round((now - date) / 1000)
  if (seconds < 45) return "just now"
  if (seconds < 3600) return Math.max(1, Math.round(seconds / 60)) + "m ago"
  if (seconds < 21600) return Math.round(seconds / 3600) + "h ago"
  var days = dayDiff(now, date)
  if (days === 0) return "today " + clock(date)
  if (days === 1) return "yesterday " + clock(date)
  return shortDate(date)
}

function formatEventTime(date, now) {
  if (!date) return ""
  now = now || new Date()
  var days = dayDiff(now, date)
  if (days === 0) return "Today " + clock(date)
  if (days === 1) return "Yesterday " + clock(date)
  return shortDate(date) + (hasClockTime(date) ? " " + clock(date) : "")
}

var NO_LONGER_ACTIVE = "No longer active"

// Which parcels changed state between two fetches. Feeds desktop notifications.
// A parcel that drops out of the list is reported as "no longer active", not as
// delivered: Parcel's active feed doesn't say whether it was delivered, deleted
// or archived. Users who want explicit Delivered transitions use filterMode
// "recent", where status 0 shows up as a real state change.
function diffStatuses(previous, next) {
  var before = {}
  for (var i = 0; i < previous.length; i++) before[previous[i].key] = previous[i]
  var after = {}
  var changes = []
  for (var j = 0; j < next.length; j++) {
    var d = next[j]
    after[d.key] = d
    var prev = before[d.key]
    if (!prev) continue // first sight of a parcel: no notification, the phone already did that
    if (prev.statusCode !== d.statusCode) {
      changes.push({ key: d.key, description: d.description, from: prev.status, to: d.status, glyph: d.glyph, tone: d.tone, delivery: d })
    }
  }
  for (var key in before) {
    if (after[key]) continue
    var gone = before[key]
    if (gone.statusCode !== 0) {
      changes.push({ key: key, description: gone.description, from: gone.status, to: NO_LONGER_ACTIVE, glyph: BAR_GLYPH, tone: "muted", removed: true, delivery: gone })
    }
  }
  return changes
}

function notificationFor(change) {
  var headline = change.description
  var body = change.to
  if (change.removed) {
    body = "No longer in your active deliveries — delivered or removed"
  } else if (change.delivery && change.delivery.latestEvent && change.delivery.latestEvent.event && change.to !== STATUS[0].label) {
    body += " · " + change.delivery.latestEvent.event
  }
  var urgency = change.tone === "urgent" ? "normal" : "low"
  return { headline: headline, body: body, glyph: change.glyph, urgency: urgency }
}

var SETUP_COMMAND = "secret-tool store --label='Parcel API key' service omarchy-parcel key api-key"

if (typeof module !== "undefined") {
  module.exports = {
    STATUS: STATUS,
    MAX_TEXT: MAX_TEXT,
    MAX_DELIVERIES: MAX_DELIVERIES,
    MAX_EVENTS: MAX_EVENTS,
    trim: trim,
    BAR_GLYPH: BAR_GLYPH,
    SETUP_COMMAND: SETUP_COMMAND,
    NO_LONGER_ACTIVE: NO_LONGER_ACTIVE,
    statusFor: statusFor,
    parseDate: parseDate,
    parseCarriers: parseCarriers,
    carrierName: carrierName,
    normalizeDelivery: normalizeDelivery,
    sortDeliveries: sortDeliveries,
    parseResponse: parseResponse,
    activeDeliveries: activeDeliveries,
    leadDelivery: leadDelivery,
    badgeText: badgeText,
    badgeUrgent: badgeUrgent,
    summaryLine: summaryLine,
    formatEta: formatEta,
    formatRelative: formatRelative,
    formatEventTime: formatEventTime,
    diffStatuses: diffStatuses,
    notificationFor: notificationFor
  }
}

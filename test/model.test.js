// Run with: node --test test/
const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

const NOW = new Date(2026, 7, 28, 9, 30) // Fri 28 Aug 2026 09:30 local

function response(deliveries, extra) {
  return JSON.stringify(Object.assign({ ok: true, mode: "active", fetchedAt: 1787000000, cached: false, stale: false, deliveries }, extra || {}))
}

const carriers = { au: "Australia Post", fedex: "FedEx", fastau: "Fastway (Aramex)" }

const SAMPLE = [
  { carrier_code: "au", description: "Coffee machine", status_code: 3, tracking_number: "AAA111",
    events: [
      { event: "In transit", date: "27.08.2026 07:41", location: "RICHMOND VIC" },
      { event: "Awaiting collection at RICHMOND PO", date: "27.08.2026 07:47", location: "RICHMOND VIC" }
    ] },
  { carrier_code: "fastau", description: "Server rack", status_code: 4, tracking_number: "BBB222", date_expected: "2026-08-28 00:00:00", events: [] },
  { carrier_code: "fedex", description: "Sunglasses", status_code: 2, tracking_number: "CCC333",
    date_expected: "2026-08-28 10:00:00", date_expected_end: "2026-08-28 14:00:00", events: [{ event: "Departed", date: "26.08.2026 22:10" }] },
  { carrier_code: "dhl", description: "Old thing", status_code: 0, tracking_number: "DDD444", events: [] }
]

test("parseDate handles both Parcel formats and rejects junk", () => {
  const ev = Model.parseDate("27.08.2026 07:47")
  assert.equal(ev.getFullYear(), 2026); assert.equal(ev.getMonth(), 7); assert.equal(ev.getDate(), 27); assert.equal(ev.getHours(), 7); assert.equal(ev.getMinutes(), 47)
  const ex = Model.parseDate("2026-08-28 10:00:00")
  assert.equal(ex.getDate(), 28); assert.equal(ex.getHours(), 10)
  assert.equal(Model.parseDate(""), null)
  assert.equal(Model.parseDate("not a date"), null)
  assert.equal(Model.parseDate(undefined), null)
})

test("parseCarriers accepts the raw API object and the parcel-api wrapper", () => {
  assert.deepEqual(Model.parseCarriers('{"au":{"name":"Australia Post"}}'), { au: "Australia Post" })
  assert.deepEqual(Model.parseCarriers('{"ok":true,"carriers":{"dhl":{"name":"DHL Express"}}}'), { dhl: "DHL Express" })
  assert.deepEqual(Model.parseCarriers("garbage"), {})
  assert.deepEqual(Model.parseCarriers('{"ok":false,"error":"no-carriers","message":"x"}'), {}, "error wrapper is not a carrier list")
  assert.deepEqual(Model.parseCarriers('{"ok":true,"source":"bundled"}'), {})
  assert.equal(Model.carrierName("zzz", {}), "ZZZ")
  assert.equal(Model.carrierName("", {}), "")
})

test("parseResponse normalises, sorts by urgency, and never throws", () => {
  const r = Model.parseResponse(response(SAMPLE), carriers)
  assert.equal(r.ok, true)
  assert.equal(r.deliveries.length, 4)
  assert.deepEqual(r.deliveries.map(d => d.description), ["Server rack", "Coffee machine", "Sunglasses", "Old thing"])
  const rack = r.deliveries[0]
  assert.equal(rack.status, "Out for delivery"); assert.equal(rack.tone, "urgent"); assert.equal(rack.carrierName, "Fastway (Aramex)")
  const coffee = r.deliveries[1]
  assert.equal(coffee.latestEvent.event, "Awaiting collection at RICHMOND PO", "events are ordered newest first regardless of input order")
  assert.equal(coffee.key, "au:AAA111")
  assert.equal(r.fetchedAt, 1787000000 * 1000)

  assert.equal(Model.parseResponse("", carriers).ok, false)
  assert.equal(Model.parseResponse("{not json", carriers).error, "bad-response")
  assert.equal(Model.parseResponse('{"ok":false,"error":"no-key","message":"m"}', carriers).error, "no-key")
  const noList = Model.parseResponse('{"ok":true,"mode":"active","fetchedAt":1}', carriers)
  assert.equal(noList.ok, false); assert.equal(noList.error, "bad-response"); assert.deepEqual(noList.deliveries, [])
})

test("stale cache responses stay ok but flagged", () => {
  const r = Model.parseResponse(response(SAMPLE, { stale: true, error: "network", message: "offline" }), carriers)
  assert.equal(r.ok, true); assert.equal(r.stale, true); assert.equal(r.error, "network")
})

test("badge, lead and summary", () => {
  const list = Model.parseResponse(response(SAMPLE), carriers).deliveries
  assert.equal(Model.activeDeliveries(list).length, 3)
  assert.equal(Model.badgeText(list), Model.BAR_GLYPH + " 3")
  assert.equal(Model.badgeUrgent(list), true)
  assert.equal(Model.leadDelivery(list).description, "Server rack")
  assert.equal(Model.summaryLine(list), "3 deliveries · 1 out for delivery")
  assert.equal(Model.summaryLine(list.slice(2, 3)), "1 delivery · in transit")
  assert.equal(Model.badgeText([]), Model.BAR_GLYPH)
  assert.equal(Model.badgeUrgent([]), false)
  assert.equal(Model.summaryLine([]), "No active deliveries")
})

test("formatEta", () => {
  const list = Model.parseResponse(response(SAMPLE), carriers).deliveries
  const byName = Object.fromEntries(list.map(d => [d.description, d]))
  assert.equal(Model.formatEta(byName["Server rack"], NOW), "Today")
  assert.equal(Model.formatEta(byName["Sunglasses"], NOW), "Today 10:00–14:00")
  assert.equal(Model.formatEta(byName["Coffee machine"], NOW), "")
  const tomorrow = Model.normalizeDelivery({ status_code: 2, date_expected: "2026-08-29 00:00:00" }, {})
  assert.equal(Model.formatEta(tomorrow, NOW), "Tomorrow")
  const later = Model.normalizeDelivery({ status_code: 2, date_expected: "2026-09-02 00:00:00" }, {})
  assert.equal(Model.formatEta(later, NOW), "Wed 2 Sep")
  const late = Model.normalizeDelivery({ status_code: 2, date_expected: "2026-08-24 00:00:00" }, {})
  assert.equal(Model.formatEta(late, NOW), "Was due Mon 24 Aug")
  const fromTimestamp = Model.normalizeDelivery({ status_code: 2, timestamp_expected: Math.floor(new Date(2026, 7, 28, 15, 0).getTime() / 1000) }, {})
  assert.equal(Model.formatEta(fromTimestamp, NOW), "Today 15:00")
  const both = Model.normalizeDelivery({ status_code: 2, date_expected: "2026-08-28 09:00:00",
    timestamp_expected: Math.floor(new Date(2026, 7, 28, 15, 0).getTime() / 1000) }, {})
  assert.equal(Model.formatEta(both, NOW), "Today 15:00", "epoch timestamp wins over the zone-less string")
})

test("formatRelative and formatEventTime", () => {
  assert.equal(Model.formatRelative(new Date(NOW - 10 * 1000), NOW), "just now")
  assert.equal(Model.formatRelative(new Date(NOW - 4 * 60 * 1000), NOW), "4m ago")
  assert.equal(Model.formatRelative(new Date(NOW - 3 * 3600 * 1000), NOW), "3h ago")
  assert.equal(Model.formatRelative(new Date(2026, 7, 27, 14, 2), NOW), "yesterday 14:02")
  assert.equal(Model.formatRelative(new Date(2026, 7, 24, 8, 0), NOW), "Mon 24 Aug")
  assert.equal(Model.formatEventTime(new Date(2026, 7, 28, 7, 47), NOW), "Today 07:47")
  assert.equal(Model.formatEventTime(new Date(2026, 7, 26, 22, 10), NOW), "Wed 26 Aug 22:10")
  assert.equal(Model.formatRelative(null, NOW), "")
})

test("diffStatuses reports transitions and disappearances, ignores first sightings", () => {
  const before = Model.parseResponse(response(SAMPLE), carriers).deliveries
  const afterRaw = [
    Object.assign({}, SAMPLE[0], { status_code: 0 }),                 // coffee: pickup → delivered
    Object.assign({}, SAMPLE[2], { status_code: 4 }),                 // sunglasses: transit → out for delivery
    { carrier_code: "ups", description: "Brand new", status_code: 2, tracking_number: "NEW1", events: [] }
    // server rack vanished from the active list → treated as delivered
    // old thing (already delivered) vanished → not reported
  ]
  const after = Model.parseResponse(response(afterRaw), carriers).deliveries
  const changes = Model.diffStatuses(before, after)
  const byDesc = Object.fromEntries(changes.map(c => [c.description, c]))
  assert.deepEqual(Object.keys(byDesc).sort(), ["Coffee machine", "Server rack", "Sunglasses"])
  assert.equal(byDesc["Sunglasses"].to, "Out for delivery")
  assert.equal(byDesc["Coffee machine"].to, "Delivered")
  assert.equal(byDesc["Server rack"].to, Model.NO_LONGER_ACTIVE, "disappearance is not inferred as delivered")
  assert.equal(byDesc["Server rack"].removed, true)
  assert.match(Model.notificationFor(byDesc["Server rack"]).body, /delivered or removed/)
  const n = Model.notificationFor(byDesc["Sunglasses"])
  assert.equal(n.headline, "Sunglasses"); assert.equal(n.urgency, "normal"); assert.match(n.body, /^Out for delivery/)
  assert.equal(Model.notificationFor(byDesc["Coffee machine"]).urgency, "low")
  assert.deepEqual(Model.diffStatuses([], after), [], "first fetch never notifies")
})

test("unknown status codes degrade gracefully", () => {
  const d = Model.normalizeDelivery({ status_code: 42, description: "Mystery" }, {})
  assert.equal(d.status, "Unknown"); assert.equal(d.rank, 0)
  assert.equal(Model.normalizeDelivery(null, {}), null)
  assert.equal(Model.normalizeDelivery({ tracking_number: "X1" }, {}).description, "X1")
})

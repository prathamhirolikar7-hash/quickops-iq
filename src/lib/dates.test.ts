import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { addDays, daysInclusive, formatIstDate, previousWindow, rangeOptions, resolveAnchor, resolveWindow } from "./dates.ts"

describe("IST date helpers", () => {
  it("adds days across month and year boundaries", () => {
    assert.equal(addDays("2026-10-01", -1), "2026-09-30")
    assert.equal(addDays("2026-12-31", 1), "2027-01-01")
    assert.equal(addDays("2028-02-28", 1), "2028-02-29") // leap year
  })

  it("counts days inclusively", () => {
    assert.equal(daysInclusive("2026-10-07", "2026-10-13"), 7)
    assert.equal(daysInclusive("2026-10-13", "2026-10-13"), 1)
  })

  it("formats a date without shifting it by the viewer's timezone", () => {
    assert.equal(formatIstDate("2026-10-13"), "13 Oct")
    assert.equal(formatIstDate("2026-10-13", true), "13 Oct 2026")
  })
})

describe("anchor from data freshness", () => {
  it("anchors on the last data day when data is stale", () => {
    assert.deepEqual(resolveAnchor("2026-10-15", "2026-10-13"), { anchor: "2026-10-13", isToday: false })
  })
  it("anchors on today when data is current", () => {
    assert.deepEqual(resolveAnchor("2026-10-15", "2026-10-15"), { anchor: "2026-10-15", isToday: true })
  })
  it("anchors on today when there is no data at all", () => {
    assert.deepEqual(resolveAnchor("2026-10-15", null), { anchor: "2026-10-15", isToday: true })
  })
  it("labels day presets honestly when the anchor is not today", () => {
    const labels = rangeOptions("2026-10-13", false).map((o) => o.label)
    assert.equal(labels[0], "Latest day (13 Oct)")
    assert.equal(labels[1], "Day before (12 Oct)")
    assert.deepEqual(rangeOptions("2026-10-15", true).slice(0, 2).map((o) => o.label), ["Today", "Yesterday"])
  })
})

describe("date windows", () => {
  const a = "2026-10-13"
  it("last 7 days ends on the anchor and spans 7 days", () => {
    const w = resolveWindow("7d", a, false)
    assert.equal(w.start, "2026-10-07")
    assert.equal(w.end, a)
    assert.equal(w.days, 7)
  })
  it("last 30 days spans 30 days", () => {
    const w = resolveWindow("30d", a, false)
    assert.equal(w.start, "2026-09-14")
    assert.equal(w.days, 30)
  })
  it("month to date starts on the 1st of the anchor month", () => {
    const w = resolveWindow("mtd", a, false)
    assert.equal(w.start, "2026-10-01")
    assert.equal(w.days, 13)
    assert.equal(w.comparisonLabel, "prev. 13 days")
  })
  it("today / yesterday are single days relative to the anchor", () => {
    assert.deepEqual([resolveWindow("today", a, false).start, resolveWindow("today", a, false).end], [a, a])
    assert.equal(resolveWindow("yesterday", a, false).start, "2026-10-12")
  })
  it("previous window matches the database definition (same length, right before)", () => {
    const w = resolveWindow("7d", a, false)
    assert.deepEqual(previousWindow(w), { start: "2026-09-30", end: "2026-10-06" })
  })
})

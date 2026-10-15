// IST business-date helpers. Dates are plain "YYYY-MM-DD" strings that mean an
// Asia/Kolkata calendar day, exactly like orders.order_date in the database.
// "Today" always comes from the server (analytics_data_freshness.today_ist),
// never from the browser clock, so a viewer in another timezone sees the same days.

export type IsoDate = string
export type DateRangeKey = "today" | "yesterday" | "7d" | "30d" | "mtd"

const DAY_MS = 86_400_000
const toUtcMs = (d: IsoDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))

export function addDays(d: IsoDate, n: number): IsoDate {
  return new Date(toUtcMs(d) + n * DAY_MS).toISOString().slice(0, 10)
}

/** Inclusive day count between two IST dates */
export function daysInclusive(start: IsoDate, end: IsoDate): number {
  return Math.round((toUtcMs(end) - toUtcMs(start)) / DAY_MS) + 1
}

/** "13 Oct" or "13 Oct 2026" */
export function formatIstDate(d: IsoDate, withYear = false): string {
  return new Date(toUtcMs(d)).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  })
}

export interface DateWindow {
  range: DateRangeKey
  start: IsoDate
  end: IsoDate
  days: number
  /** e.g. "Last 7 days" or "Latest day (13 Oct)" */
  label: string
  /** Comparison wording for KPI deltas, e.g. "prev. 7 days" */
  comparisonLabel: string
}

/**
 * The anchor is the last day the dashboard reports on: today (IST) when the
 * data is current, otherwise the latest day that has orders. Ranges are
 * anchored on it so a stale dataset never opens on an empty "today".
 */
export function resolveAnchor(todayIst: IsoDate, lastOrderDate: IsoDate | null): { anchor: IsoDate; isToday: boolean } {
  if (!lastOrderDate || lastOrderDate >= todayIst) return { anchor: todayIst, isToday: true }
  return { anchor: lastOrderDate, isToday: false }
}

export function rangeOptions(anchor: IsoDate, isToday: boolean): { value: DateRangeKey; label: string }[] {
  return [
    { value: "today", label: isToday ? "Today" : `Latest day (${formatIstDate(anchor)})` },
    { value: "yesterday", label: isToday ? "Yesterday" : `Day before (${formatIstDate(addDays(anchor, -1))})` },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "mtd", label: "Month to date" },
  ]
}

export function resolveWindow(range: DateRangeKey, anchor: IsoDate, isToday: boolean): DateWindow {
  const label = rangeOptions(anchor, isToday).find((o) => o.value === range)!.label
  const make = (start: IsoDate, end: IsoDate, comparisonLabel: string): DateWindow => ({
    range, start, end, days: daysInclusive(start, end), label, comparisonLabel,
  })
  switch (range) {
    case "today":
      return make(anchor, anchor, "previous day")
    case "yesterday": {
      const d = addDays(anchor, -1)
      return make(d, d, "previous day")
    }
    case "7d":
      return make(addDays(anchor, -6), anchor, "prev. 7 days")
    case "30d":
      return make(addDays(anchor, -29), anchor, "prev. 30 days")
    case "mtd": {
      const start = `${anchor.slice(0, 8)}01`
      const days = daysInclusive(start, anchor)
      return make(start, anchor, `prev. ${days} day${days === 1 ? "" : "s"}`)
    }
  }
}

/** The previous period used by the analytics functions: same length, right before */
export function previousWindow(w: Pick<DateWindow, "start" | "days">): { start: IsoDate; end: IsoDate } {
  return { start: addDays(w.start, -w.days), end: addDays(w.start, -1) }
}

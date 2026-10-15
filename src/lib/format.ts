import type { KpiFormat } from "@/types/dashboard"

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 })
const inr1 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 })

/** Indian short-scale currency: ₹ 4,820 · ₹ 12.4 L · ₹ 3.1 Cr */
export function formatCurrencyCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e7) return `₹${inr1.format(value / 1e7)} Cr`
  if (abs >= 1e5) return `₹${inr1.format(value / 1e5)} L`
  if (abs >= 1e3) return `₹${inr1.format(value / 1e3)}K`
  return `₹${inr.format(value)}`
}

export function formatCurrency(value: number): string {
  return `₹${inr.format(value)}`
}

/** Indian grouping with lakh / crore suffixes for large counts */
export function formatNumberCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e7) return `${inr1.format(value / 1e7)} Cr`
  if (abs >= 1e5) return `${inr1.format(value / 1e5)} L`
  return inr.format(value)
}

export function formatNumber(value: number): string {
  return inr.format(value)
}

export function formatKpi(value: number, format: KpiFormat): string {
  switch (format) {
    case "currency":
      return value >= 1e5 ? formatCurrencyCompact(value) : formatCurrency(value)
    case "percent":
      return `${value.toFixed(1)}%`
    case "minutes":
      return `${value.toFixed(1)} min`
    default:
      return formatNumberCompact(value)
  }
}

/**
 * Change vs previous period. Percent metrics report the absolute
 * point change (pp); everything else reports relative % change.
 */
export function computeDelta(current: number, previous: number, format: KpiFormat) {
  if (format === "percent") {
    const diff = current - previous
    return { diff, text: `${Math.abs(diff).toFixed(1)} pp` }
  }
  if (previous === 0) return { diff: 0, text: "—" }
  const diff = ((current - previous) / previous) * 100
  return { diff, text: `${Math.abs(diff).toFixed(1)}%` }
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

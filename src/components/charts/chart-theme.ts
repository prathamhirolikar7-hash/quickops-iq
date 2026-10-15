/** Shared Recharts styling so every chart reads as one system */
export const axisTick = { fill: "var(--chart-axis)", fontSize: 11 }
export const gridProps = { stroke: "var(--chart-grid)", strokeDasharray: "0", vertical: false }

/** Delivery buckets: within the 10-minute SLA vs beyond it */
export const SLA_COLORS = { within: "var(--chart-1)", beyond: "var(--chart-3)" }

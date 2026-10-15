import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { formatNumber, formatNumberCompact } from "@/lib/format"
import type { TrendPoint } from "@/types/dashboard"
import { ChartTooltip } from "./chart-primitives"
import { axisTick, gridProps } from "./chart-theme"

export function OrdersTrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id="orders-current" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.32} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...gridProps} />
        <XAxis
          dataKey="label"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "var(--chart-grid)" }}
          minTickGap={24}
          tickMargin={8}
        />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={formatNumberCompact} width={52} />
        <Tooltip
          cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1, strokeDasharray: "3 3" }}
          content={({ active, payload, label }) => (
            <ChartTooltip
              active={active}
              payload={payload}
              label={label}
              formatValue={(v) => `${formatNumber(v)} orders`}
              footer={(rows) => {
                const cur = Number(rows.find((r) => r.dataKey === "current")?.value ?? 0)
                const prev = Number(rows.find((r) => r.dataKey === "previous")?.value ?? 0)
                if (!prev) return null
                const pct = ((cur - prev) / prev) * 100
                return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs previous period`
              }}
            />
          )}
        />
        <Line
          type="monotone"
          dataKey="previous"
          name="Previous period"
          stroke="var(--chart-2)"
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
        />
        <Area
          type="monotone"
          dataKey="current"
          name="Current period"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#orders-current)"
          dot={false}
          activeDot={{ r: 4.5, strokeWidth: 2, stroke: "var(--card)" }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

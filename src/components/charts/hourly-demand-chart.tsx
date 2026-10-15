import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { formatNumber, formatNumberCompact } from "@/lib/format"
import type { HourlyPoint } from "@/types/dashboard"
import { ChartTooltip } from "./chart-primitives"
import { axisTick, gridProps } from "./chart-theme"

export function HourlyDemandChart({ data }: { data: HourlyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap={2}>
        <CartesianGrid {...gridProps} />
        <XAxis
          dataKey="hour"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "var(--chart-grid)" }}
          interval={2}
          tickMargin={8}
          tickFormatter={(h: string) => `${h}h`}
        />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={formatNumberCompact} width={52} />
        <Tooltip
          cursor={{ fill: "var(--accent)", opacity: 0.5 }}
          content={({ active, payload, label }) => (
            <ChartTooltip
              active={active}
              payload={payload}
              label={`${label}:00 – ${label}:59`}
              formatValue={(v) => `${formatNumber(v)} orders`}
            />
          )}
        />
        <Bar dataKey="orders" name="Avg orders" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  )
}

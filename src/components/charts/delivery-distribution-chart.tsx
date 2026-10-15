import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { formatNumber, formatNumberCompact } from "@/lib/format"
import type { DeliveryBucket } from "@/types/dashboard"
import { ChartTooltip } from "./chart-primitives"
import { axisTick, gridProps, SLA_COLORS } from "./chart-theme"

export function DeliveryDistributionChart({ data }: { data: DeliveryBucket[] }) {
  const total = data.reduce((a, b) => a + b.orders, 0)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap={6}>
        <CartesianGrid {...gridProps} />
        <XAxis
          dataKey="bucket"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "var(--chart-grid)" }}
          tickMargin={8}
          interval={0}
        />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={formatNumberCompact} width={52} />
        <Tooltip
          cursor={{ fill: "var(--accent)", opacity: 0.5 }}
          content={({ active, payload, label }) => (
            <ChartTooltip
              active={active}
              payload={payload}
              label={`${label} min`}
              formatValue={(v) => `${formatNumber(v)} orders`}
              footer={(rows) => {
                const point = (rows[0] as { payload?: DeliveryBucket } | undefined)?.payload
                if (!point || !total) return null
                return `${((point.orders / total) * 100).toFixed(1)}% of orders · ${point.withinSla ? "within" : "beyond"} SLA`
              }}
            />
          )}
        />
        <Bar dataKey="orders" name="Orders" radius={[4, 4, 0, 0]} maxBarSize={40}>
          {data.map((d) => (
            <Cell key={d.bucket} fill={d.withinSla ? SLA_COLORS.within : SLA_COLORS.beyond} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

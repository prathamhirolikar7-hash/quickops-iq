import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { formatCurrencyCompact, formatNumber } from "@/lib/format"
import type { BreakdownPoint } from "@/types/dashboard"
import { ChartTooltip } from "./chart-primitives"
import { axisTick, gridProps } from "./chart-theme"

interface GmvBreakdownChartProps {
  data: BreakdownPoint[]
  /** Store id to emphasise; other bars are dimmed */
  highlightId?: string
}

export function GmvBreakdownChart({ data, highlightId }: GmvBreakdownChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={10}>
        <CartesianGrid {...gridProps} horizontal={false} vertical />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ ...axisTick, fill: "var(--muted-foreground)", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={128}
        />
        <Tooltip
          cursor={{ fill: "var(--accent)", opacity: 0.5 }}
          content={({ active, payload, label }) => (
            <ChartTooltip
              active={active}
              payload={payload}
              label={label}
              formatValue={(v) => formatCurrencyCompact(v)}
              footer={(rows) => {
                const point = (rows[0] as { payload?: BreakdownPoint } | undefined)?.payload
                return point ? `${formatNumber(point.orders)} orders` : null
              }}
            />
          )}
        />
        <Bar dataKey="gmv" name="GMV" radius={[0, 4, 4, 0]} maxBarSize={22}>
          {data.map((d) => (
            <Cell
              key={d.id}
              fill="var(--chart-1)"
              fillOpacity={highlightId && highlightId !== d.id ? 0.35 : 1}
            />
          ))}
          <LabelList
            dataKey="gmv"
            position="right"
            formatter={(v) => formatCurrencyCompact(Number(v))}
            style={{ fill: "var(--foreground)", fontSize: 11, fontWeight: 500 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

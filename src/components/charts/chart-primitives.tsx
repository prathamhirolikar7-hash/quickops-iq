import type { ReactNode } from "react"

interface TooltipRow {
  name?: string | number
  value?: unknown
  color?: string
  dataKey?: unknown
}

interface ChartTooltipProps {
  active?: boolean
  payload?: ReadonlyArray<TooltipRow>
  label?: ReactNode
  formatValue: (value: number, row: TooltipRow) => string
  labelPrefix?: string
  footer?: (rows: ReadonlyArray<TooltipRow>) => ReactNode
}

export function ChartTooltip({ active, payload, label, formatValue, labelPrefix, footer }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="min-w-40 rounded-lg border border-border bg-popover/95 px-3 py-2.5 text-xs shadow-xl shadow-black/40 backdrop-blur">
      <p className="mb-1.5 font-medium text-foreground">
        {labelPrefix}
        {label}
      </p>
      <div className="space-y-1">
        {payload.map((row) => (
          <div key={String(row.dataKey ?? row.name)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: row.color }} aria-hidden />
              {row.name}
            </span>
            <span className="tabular font-medium text-foreground">{formatValue(Number(row.value), row)}</span>
          </div>
        ))}
      </div>
      {footer && <div className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">{footer(payload)}</div>}
    </div>
  )
}

export interface LegendItem {
  label: string
  color: string
  dashed?: boolean
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          {item.dashed ? (
            <span className="h-0 w-3.5 border-t-2 border-dashed" style={{ borderColor: item.color }} aria-hidden />
          ) : (
            <span className="size-2.5 rounded-sm" style={{ background: item.color }} aria-hidden />
          )}
          {item.label}
        </li>
      ))}
    </ul>
  )
}

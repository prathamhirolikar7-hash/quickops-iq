import type { LucideIcon } from "lucide-react"
import { Info, Minus, TrendingDown, TrendingUp } from "lucide-react"
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { computeDelta, formatKpi } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { KpiMetric } from "@/types/dashboard"

interface KpiCardProps {
  metric?: KpiMetric
  icon: LucideIcon
  loading?: boolean
  periodLabel?: string
}

export function KpiCard({ metric, icon: Icon, loading, periodLabel = "prev. period" }: KpiCardProps) {
  if (loading || !metric) return <KpiCardSkeleton />

  const hasValue = metric.value !== null
  // A delta needs a comparable previous value (and a non-zero base for % change)
  const delta =
    hasValue && metric.previous !== null && (metric.format === "percent" || metric.previous !== 0)
      ? computeDelta(metric.value!, metric.previous, metric.format)
      : null
  const flat = delta ? Math.abs(delta.diff) < 0.05 : true
  const improved = delta ? (metric.goodDirection === "up" ? delta.diff > 0 : delta.diff < 0) : false
  const DeltaIcon = flat ? Minus : delta!.diff > 0 ? TrendingUp : TrendingDown
  const gradientId = `spark-${metric.id}`

  return (
    <Card className="group/kpi relative gap-0 overflow-hidden border-0 p-0 transition-colors hover:ring-primary/30">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent opacity-0 transition-opacity group-hover/kpi:opacity-100" />
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-[13px] font-medium text-muted-foreground">{metric.label}</p>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="text-muted-foreground/60 transition-colors hover:text-foreground"
                  aria-label={`About ${metric.label}`}
                />
              }
            >
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{metric.hint}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
          <Icon className="size-4" aria-hidden />
        </div>
      </div>

      <div className="px-4 pt-1">
        <p className="text-[26px] leading-tight font-semibold tracking-tight text-foreground">
          {hasValue ? formatKpi(metric.value!, metric.format) : "—"}
        </p>
        <div className="mt-1.5 flex h-5 items-center gap-1.5 text-xs">
          {delta ? (
            <>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium",
                  flat
                    ? "bg-muted text-muted-foreground"
                    : improved
                      ? "bg-success/10 text-success"
                      : "bg-destructive/10 text-destructive",
                )}
              >
                <DeltaIcon className="size-3" aria-hidden />
                {delta.text}
                <span className="sr-only">{improved ? "(improved)" : "(worsened)"}</span>
              </span>
              <span className="text-muted-foreground">vs {periodLabel}</span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {hasValue ? `No comparison data for ${periodLabel}` : "No data for this selection"}
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 h-12" aria-hidden>
        {hasValue && metric.sparkline.length > 1 && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={metric.sparkline.map((v, i) => ({ i, v }))} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Area
                type="monotone"
                dataKey="v"
                stroke="var(--chart-1)"
                strokeWidth={1.75}
                fill={`url(#${gradientId})`}
                activeDot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  )
}

function KpiCardSkeleton() {
  return (
    <Card className="gap-0 border-0 p-0" aria-busy="true" aria-label="Loading metric">
      <div className="flex items-start justify-between px-4 pt-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="size-8 rounded-lg" />
      </div>
      <div className="space-y-2.5 px-4 pt-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-36" />
      </div>
      <Skeleton className="mx-4 mt-3 mb-3 h-9 rounded-md" />
    </Card>
  )
}

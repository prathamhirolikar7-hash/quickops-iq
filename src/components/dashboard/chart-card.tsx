import type { ReactNode } from "react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { EmptyState, ErrorState } from "./state-views"

interface ChartCardProps {
  title: string
  description?: string
  action?: ReactNode
  /** Legend shown under the header so it never squeezes the title */
  legend?: ReactNode
  /** Height of the plot area in px; the card stays fluid in width */
  height?: number
  loading?: boolean
  /** Refetching in the background while previous data stays on screen */
  refreshing?: boolean
  empty?: boolean
  emptyMessage?: string
  /** The query failed and there is nothing to show */
  error?: boolean
  onRetry?: () => void
  className?: string
  children: ReactNode
}

/**
 * Responsive container for every chart on the dashboard: consistent header,
 * fixed plot height, and built-in loading / empty / refreshing states.
 */
export function ChartCard({
  title,
  description,
  action,
  legend,
  height = 280,
  loading,
  refreshing,
  empty,
  emptyMessage,
  error,
  onRetry,
  className,
  children,
}: ChartCardProps) {
  const showContent = !loading && !error && !empty
  return (
    <Card className={cn("gap-4 border-0", className)}>
      <CardHeader>
        <CardTitle className="text-[15px] font-semibold">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
        {action && showContent && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="min-w-0 space-y-3">
        {legend && showContent && legend}
        <div
          className={cn("relative w-full min-w-0 transition-opacity", refreshing && "opacity-60")}
          style={{ height }}
          aria-busy={loading || refreshing}
        >
          {loading ? (
            <ChartSkeleton />
          ) : error ? (
            <ErrorState onRetry={() => onRetry?.()} />
          ) : empty ? (
            <EmptyState description={emptyMessage} />
          ) : (
            children
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ChartSkeleton() {
  const bars = [45, 62, 38, 70, 55, 80, 66, 50, 74, 58, 42, 68]
  return (
    <div className="flex h-full flex-col justify-end gap-3" aria-label="Loading chart">
      <div className="flex flex-1 items-end gap-2">
        {bars.map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-t-md rounded-b-none" style={{ height: `${h}%` }} />
        ))}
      </div>
      <Skeleton className="h-3 w-full" />
    </div>
  )
}

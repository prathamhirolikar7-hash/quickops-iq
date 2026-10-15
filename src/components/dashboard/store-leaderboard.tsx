import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatCurrencyCompact, formatNumber } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { StoreRow } from "@/types/dashboard"
import { EmptyState, ErrorState } from "./state-views"

interface StoreLeaderboardProps {
  rows: StoreRow[]
  loading?: boolean
  refreshing?: boolean
  error?: boolean
  onRetry?: () => void
}

export function StoreLeaderboard({ rows, loading, refreshing, error, onRetry }: StoreLeaderboardProps) {
  return (
    <Card className="gap-4 border-0">
      <CardHeader>
        <CardTitle className="text-[15px] font-semibold">Top dark stores</CardTitle>
        <CardDescription className="text-xs">Ranked by GMV for the selected period</CardDescription>
      </CardHeader>
      <CardContent className={cn("transition-opacity", refreshing && "opacity-60")}>
        {loading ? (
          <div className="space-y-2.5" aria-label="Loading table">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorState onRetry={() => onRetry?.()} />
        ) : rows.length === 0 ? (
          <EmptyState description="No store received orders in this selection." />
        ) : (
          <div className="scrollbar-thin -mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="w-10 pb-2.5 font-medium">#</th>
                  <th scope="col" className="pb-2.5 font-medium">Store</th>
                  <th scope="col" className="pb-2.5 font-medium">City</th>
                  <th scope="col" className="pb-2.5 text-right font-medium">Orders</th>
                  <th scope="col" className="pb-2.5 text-right font-medium">GMV</th>
                  <th scope="col" className="pb-2.5 text-right font-medium">Avg delivery</th>
                  <th scope="col" className="w-44 pb-2.5 pl-6 font-medium">On-time %</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {rows.map((row, i) => (
                  <tr key={row.id} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                    <td className="py-2.5 text-muted-foreground">{i + 1}</td>
                    <td className="py-2.5 font-medium text-foreground">{row.name}</td>
                    <td className="py-2.5 text-muted-foreground">{row.city}</td>
                    <td className="py-2.5 text-right">{formatNumber(row.orders)}</td>
                    <td className="py-2.5 text-right font-medium">{formatCurrencyCompact(row.gmv)}</td>
                    <td className="py-2.5 text-right">
                      {row.avgDeliveryMin == null ? "—" : `${row.avgDeliveryMin.toFixed(1)} min`}
                    </td>
                    <td className="py-2.5 pl-6">
                      <div className="flex items-center gap-2.5">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${row.onTimePct ?? 0}%` }} />
                        </div>
                        <span className="w-11 text-right text-xs">{row.onTimePct == null ? "—" : `${row.onTimePct.toFixed(1)}%`}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

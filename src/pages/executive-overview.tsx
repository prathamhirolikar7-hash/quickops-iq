import { useMemo, type ReactNode } from "react"
import { Ban, Clock, IndianRupee, ShoppingCart, Timer, Wallet } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { ChartLegend } from "@/components/charts/chart-primitives"
import { SLA_COLORS } from "@/components/charts/chart-theme"
import { DeliveryDistributionChart } from "@/components/charts/delivery-distribution-chart"
import { GmvBreakdownChart } from "@/components/charts/gmv-breakdown-chart"
import { HourlyDemandChart } from "@/components/charts/hourly-demand-chart"
import { OrdersTrendChart } from "@/components/charts/orders-trend-chart"
import { ChartCard } from "@/components/dashboard/chart-card"
import { DataBadge } from "@/components/dashboard/data-badge"
import { FilterBar } from "@/components/dashboard/filter-bar"
import { KpiCard } from "@/components/dashboard/kpi-card"
import { ErrorState } from "@/components/dashboard/state-views"
import { StoreLeaderboard } from "@/components/dashboard/store-leaderboard"
import {
  useCityPerformance, useDaily, useDeliveryDistribution, useHourly, useOverview, useStorePerformance,
} from "@/hooks/use-analytics"
import { useDashboardScope } from "@/hooks/use-dashboard-scope"
import {
  buildKpis, cityBreakdown, dailyTrend, deliveryBuckets, hourlyDemand, hourlyTrend, leaderboard, storeBreakdown,
} from "@/lib/dashboard-mappers"
import { formatIstDate, previousWindow } from "@/lib/dates"
import type { DashboardFilters } from "@/types/dashboard"

const KPI_ICONS: Record<string, LucideIcon> = {
  orders: ShoppingCart,
  gmv: IndianRupee,
  aov: Wallet,
  delivery: Timer,
  ontime: Clock,
  cancel: Ban,
}
const KPI_ORDER = Object.keys(KPI_ICONS)

interface ExecutiveOverviewProps {
  filters: DashboardFilters
  onFiltersChange: (next: DashboardFilters) => void
}

export function ExecutiveOverview({ filters, onFiltersChange }: ExecutiveOverviewProps) {
  // ---- Shared scope: IST date window, filters, filter-bar options
  const { freshness, anchor, period, cityId, storeId, storeCityId, scope, scopeLabel, filterBarProps } =
    useDashboardScope(filters)
  const single = period?.days === 1
  const prevDay = period && single ? previousWindow(period) : null

  // ---- Section queries (server-side aggregates only)
  const overview = useOverview(scope)
  const daily = useDaily(scope && !single ? scope : null)
  const hourly = useHourly(scope)
  const prevHourly = useHourly(scope && prevDay ? { ...scope, start: prevDay.start, end: prevDay.end } : null)

  const breakdownLevel = cityId === null && storeId === null ? "city" : "store"
  const breakdownCity = cityId ?? storeCityId
  const cityPerf = useCityPerformance(breakdownLevel === "city" ? scope : null)
  const storeBreakdownQ = useStorePerformance(
    breakdownLevel === "store" && scope && breakdownCity ? { ...scope, cityId: breakdownCity, storeId: null } : null,
  )
  const storesInScope = useStorePerformance(scope)
  const distribution = useDeliveryDistribution(scope)

  // ---- Map rows to the existing component props
  const kpis = useMemo(
    () => (overview.data ? buildKpis(overview.data, single ? [] : (daily.data ?? [])) : null),
    [overview.data, daily.data, single],
  )
  const trend = useMemo(() => {
    if (single) return hourly.data && prevHourly.data ? hourlyTrend(hourly.data, prevHourly.data) : null
    return daily.data ? dailyTrend(daily.data) : null
  }, [single, hourly.data, prevHourly.data, daily.data])
  const trendQuery = single ? (hourly.isPending ? hourly : prevHourly) : daily
  const trendError = single ? hourly.isError || prevHourly.isError : daily.isError
  const breakdownQuery = breakdownLevel === "city" ? cityPerf : storeBreakdownQ
  const breakdown = useMemo(
    () =>
      breakdownLevel === "city"
        ? cityPerf.data && cityBreakdown(cityPerf.data)
        : storeBreakdownQ.data && storeBreakdown(storeBreakdownQ.data),
    [breakdownLevel, cityPerf.data, storeBreakdownQ.data],
  )

  // ---- Labels and states
  const noOrders = overview.data ? Number(overview.data.total_orders) === 0 : false
  const emptyMessage = period ? `No orders for this selection in ${period.label.toLowerCase()}.` : undefined
  const refreshing = (q: { isFetching: boolean; isPlaceholderData: boolean }) => q.isFetching && q.isPlaceholderData

  if (freshness.isError) {
    return (
      <PageFrame>
        <ErrorState onRetry={() => freshness.refetch()} />
      </PageFrame>
    )
  }

  return (
    <PageFrame>
      {/* Page heading */}
      <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">Executive Overview</h1>
            <DataBadge className="sm:hidden" />
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Orders, revenue, and delivery performance across dark stores
            {period && (
              <>
                {" · "}
                <span className="text-foreground/80">
                  {period.label}, {scopeLabel}
                </span>
              </>
            )}
            {anchor && !anchor.isToday && freshness.data?.last_order_date && (
              <> · Data through {formatIstDate(freshness.data.last_order_date, true)} (IST)</>
            )}
            {overview.data?.is_partial_period && <> · Today is still in progress</>}
          </p>
        </div>
        <FilterBar value={filters} onChange={onFiltersChange} {...filterBarProps} />
      </div>

      {/* KPI row */}
      {overview.isError && !overview.data ? (
        <ErrorState onRetry={() => overview.refetch()} />
      ) : (
        <section aria-label="Key metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {KPI_ORDER.map((id) => (
            <KpiCard
              key={id}
              icon={KPI_ICONS[id]}
              loading={overview.isPending}
              metric={kpis?.find((k) => k.id === id)}
              periodLabel={period?.comparisonLabel}
            />
          ))}
        </section>
      )}

      {/* Charts */}
      <section aria-label="Charts" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Order volume trend"
          description={single ? "Orders per hour (IST) vs the previous day" : "Orders per day vs the previous period"}
          legend={
            <ChartLegend
              items={[
                { label: "Current period", color: "var(--chart-1)" },
                { label: "Previous period", color: "var(--chart-2)", dashed: true },
              ]}
            />
          }
          height={272}
          loading={trendQuery.isPending}
          refreshing={refreshing(trendQuery)}
          error={trendError && !trend}
          onRetry={() => { if (single) { hourly.refetch(); prevHourly.refetch() } else daily.refetch() }}
          empty={noOrders}
          emptyMessage={emptyMessage}
        >
          {trend && <OrdersTrendChart data={trend} />}
        </ChartCard>

        <ChartCard
          title={breakdownLevel === "store" ? "GMV by store" : "GMV by city"}
          description={breakdownLevel === "store" ? "Stores in the selected city" : "Gross merchandise value, all cities"}
          height={300}
          loading={breakdownQuery.isPending}
          refreshing={refreshing(breakdownQuery)}
          error={breakdownQuery.isError && !breakdown}
          onRetry={() => breakdownQuery.refetch()}
          empty={!breakdownQuery.isPending && (noOrders || !breakdown || breakdown.length === 0)}
          emptyMessage={emptyMessage}
        >
          {breakdown && <GmvBreakdownChart data={breakdown} highlightId={storeId ?? undefined} />}
        </ChartCard>

        <ChartCard
          className="lg:col-span-2"
          title="Demand by hour of day"
          description={
            single
              ? "Orders by hour (IST): plan rider shifts around the peaks"
              : "Average orders per hour (IST): plan rider shifts around the peaks"
          }
          height={260}
          loading={hourly.isPending}
          refreshing={refreshing(hourly)}
          error={hourly.isError && !hourly.data}
          onRetry={() => hourly.refetch()}
          empty={noOrders}
          emptyMessage={emptyMessage}
        >
          {hourly.data && period && <HourlyDemandChart data={hourlyDemand(hourly.data, period.days)} />}
        </ChartCard>

        <ChartCard
          title="Delivery time distribution"
          description="Delivered orders by delivery time (minutes) vs the 10-minute SLA"
          legend={
            <ChartLegend
              items={[
                { label: "Within SLA (≤ 10 min)", color: SLA_COLORS.within },
                { label: "Beyond SLA", color: SLA_COLORS.beyond },
              ]}
            />
          }
          height={232}
          loading={distribution.isPending}
          refreshing={refreshing(distribution)}
          error={distribution.isError && !distribution.data}
          onRetry={() => distribution.refetch()}
          empty={noOrders || (overview.data ? Number(overview.data.delivered_orders) === 0 : false)}
          emptyMessage={noOrders ? emptyMessage : "No delivered orders in this selection yet."}
        >
          {distribution.data && <DeliveryDistributionChart data={deliveryBuckets(distribution.data)} />}
        </ChartCard>
      </section>

      <StoreLeaderboard
        rows={storesInScope.data ? leaderboard(storesInScope.data) : []}
        loading={storesInScope.isPending}
        refreshing={refreshing(storesInScope)}
        error={storesInScope.isError && !storesInScope.data}
        onRetry={() => storesInScope.refetch()}
      />

      <p className="pb-2 text-center text-[11px] text-muted-foreground/80">
        Live from the QuickOps IQ Supabase database. All records are{" "}
        <strong className="font-semibold text-warning">synthetic</strong> and describe a fictional company, not any real
        business. Dates are IST.
      </p>
    </PageFrame>
  )
}

function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:py-8" id="overview">
      {children}
    </div>
  )
}

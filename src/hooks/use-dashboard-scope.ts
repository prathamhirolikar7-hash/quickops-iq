import { useDataFreshness, useCityOptions, useStoreOptions } from "@/hooks/use-analytics"
import type { AnalyticsScope } from "@/lib/analytics"
import { rangeOptions, resolveAnchor, resolveWindow } from "@/lib/dates"
import { ALL, type DashboardFilters } from "@/types/dashboard"

/**
 * Shared date/city/store scope for every dashboard page: the IST date window
 * (anchored on the latest data day via analytics_data_freshness), the
 * analytics scope, a human label, and the props for <FilterBar>.
 */
export function useDashboardScope(filters: DashboardFilters) {
  const freshness = useDataFreshness()
  const cities = useCityOptions()
  const stores = useStoreOptions()

  const anchor = freshness.data ? resolveAnchor(freshness.data.today_ist, freshness.data.last_order_date) : null
  const period = anchor ? resolveWindow(filters.range, anchor.anchor, anchor.isToday) : null

  const cityId = filters.city !== ALL ? filters.city : null
  const storeId = filters.store !== ALL ? filters.store : null
  const storeCityId = storeId ? (stores.data?.find((s) => s.id === storeId)?.city_id ?? null) : null
  const scope: AnalyticsScope | null = period ? { start: period.start, end: period.end, cityId, storeId } : null

  const scopeLabel = storeId
    ? (stores.data?.find((s) => s.id === storeId)?.code ?? "selected store")
    : cityId
      ? (cities.data?.find((c) => c.id === cityId)?.name ?? "selected city")
      : "all cities"

  const filterBarProps = {
    cities: (cities.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    stores: (stores.data ?? []).map((s) => ({
      value: s.id,
      label: `${s.code} · ${s.locality}${s.status !== "live" ? ` (${s.status})` : ""}`,
      cityId: s.city_id,
    })),
    ranges: anchor ? rangeOptions(anchor.anchor, anchor.isToday) : [],
    disabled: !anchor || cities.isPending || stores.isPending,
  }

  return { freshness, anchor, period, cityId, storeId, storeCityId, scope, scopeLabel, filterBarProps }
}

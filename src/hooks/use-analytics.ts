import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { analytics, type AnalyticsScope, type OrdersPageParams } from "@/lib/analytics"

/**
 * TanStack Query hooks for the analytics RPCs. Every key starts with
 * "analytics" so the header refresh can invalidate them together.
 * A null scope disables the query (e.g. a chart that is not shown).
 */
const STALE_MS = 60_000

const scopeKey = (s: AnalyticsScope | null) => (s ? [s.start, s.end, s.cityId, s.storeId] : ["disabled"])

function useScoped<T>(name: string, scope: AnalyticsScope | null, fn: (s: AnalyticsScope) => Promise<T>) {
  return useQuery({
    queryKey: ["analytics", name, ...scopeKey(scope)],
    queryFn: () => fn(scope!),
    enabled: scope !== null,
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
  })
}

export const useDataFreshness = () =>
  useQuery({ queryKey: ["analytics", "freshness"], queryFn: analytics.dataFreshness, staleTime: 5 * 60_000 })

export const useOverview = (s: AnalyticsScope | null) => useScoped("overview", s, analytics.overview)
export const useDaily = (s: AnalyticsScope | null) => useScoped("daily", s, analytics.daily)
export const useHourly = (s: AnalyticsScope | null) => useScoped("hourly", s, analytics.hourly)
export const useCityPerformance = (s: AnalyticsScope | null) => useScoped("city-performance", s, analytics.cityPerformance)
export const useStorePerformance = (s: AnalyticsScope | null) => useScoped("store-performance", s, analytics.storePerformance)
export const useDeliveryDistribution = (s: AnalyticsScope | null) =>
  useScoped("delivery-distribution", s, analytics.deliveryDistribution)

/** Orders explorer page (server-side filter/search/sort/pagination) */
export const useOrdersPage = (s: AnalyticsScope | null, p: OrdersPageParams) =>
  useQuery({
    queryKey: ["analytics", "orders-page", ...scopeKey(s), p.statuses?.join(",") ?? "all", p.search.trim(), p.sortBy, p.sortDir, p.limit, p.offset],
    queryFn: () => analytics.ordersPage(s!, p),
    enabled: s !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })

export const useCityOptions = () =>
  useQuery({ queryKey: ["analytics", "options", "cities"], queryFn: analytics.cities, staleTime: 10 * 60_000 })
export const useStoreOptions = () =>
  useQuery({ queryKey: ["analytics", "options", "stores"], queryFn: analytics.stores, staleTime: 10 * 60_000 })

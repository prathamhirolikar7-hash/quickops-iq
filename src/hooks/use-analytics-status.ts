import { useCallback, useSyncExternalStore } from "react"
import { notifyManager, useIsFetching, useQueryClient } from "@tanstack/react-query"

/**
 * Header status for all "analytics" queries: when data was last received,
 * whether anything is loading, and a refresh that refetches them all.
 */
export function useAnalyticsStatus() {
  const queryClient = useQueryClient()
  const cache = queryClient.getQueryCache()

  const lastUpdatedMs = useSyncExternalStore(
    // batchCalls defers the notification until after the current render (the
    // cache can notify synchronously while another component is rendering and
    // creating a query), matching how TanStack's own useIsFetching subscribes.
    useCallback((notify) => cache.subscribe(notifyManager.batchCalls(notify)), [cache]),
    () => {
      let latest = 0
      for (const q of cache.findAll({ queryKey: ["analytics"] })) latest = Math.max(latest, q.state.dataUpdatedAt)
      return latest
    },
  )
  const fetching = useIsFetching({ queryKey: ["analytics"] }) > 0
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ["analytics"] }), [queryClient])

  return { lastUpdated: lastUpdatedMs ? new Date(lastUpdatedMs).toISOString() : undefined, fetching, refresh }
}

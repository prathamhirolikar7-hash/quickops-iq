import { useQuery } from "@tanstack/react-query"
import { analytics } from "@/lib/analytics"

/**
 * Is the signed-in user on the dashboard allowlist? Uses the
 * has_dashboard_access() RPC from migration 002. This only decides which
 * screen to show: the database (RLS + the analytics functions' membership
 * check) is the real enforcement.
 */
export function useDashboardAccess(userId: string | null) {
  return useQuery({
    queryKey: ["access", userId],
    queryFn: analytics.hasDashboardAccess,
    enabled: userId !== null,
    staleTime: 60_000,
  })
}

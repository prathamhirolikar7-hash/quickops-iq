import { useQuery } from "@tanstack/react-query"
import { analytics } from "@/lib/analytics"

/**
 * 'operator' | 'viewer' | null for the signed-in user (migration 005).
 * Only decides which controls to show; the simulator functions re-check
 * operator status in the database on every call.
 */
export function useDashboardRole(userId: string | null) {
  return useQuery({
    queryKey: ["access", "role", userId],
    queryFn: analytics.myRole,
    enabled: userId !== null,
    staleTime: 60_000,
  })
}

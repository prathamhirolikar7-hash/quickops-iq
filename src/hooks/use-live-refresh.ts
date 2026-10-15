import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { LiveRefreshController, type LiveStatus, type RealtimeClientLike } from "@/lib/live-refresh"
import { requireSupabase } from "@/lib/supabase"

/**
 * Live dashboard updates for approved members. Mount once (in the dashboard
 * shell): one private-channel subscription per session, removed on unmount,
 * which includes sign-out. A signal only marks the analytics queries stale; the
 * active ones refetch through the RLS-protected analytics functions.
 */
export function useLiveRefresh(): LiveStatus {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<LiveStatus>("connecting")

  useEffect(() => {
    const controller = new LiveRefreshController({
      client: requireSupabase() as unknown as RealtimeClientLike,
      onRefresh: () => {
        void queryClient.invalidateQueries({ queryKey: ["analytics"], refetchType: "active" })
      },
      onStatus: setStatus,
      isVisible: () => document.visibilityState === "visible",
      log: import.meta.env.DEV ? (m) => console.debug(`[quickops live] ${m}`) : undefined,
    })
    controller.start()
    return () => controller.stop()
  }, [queryClient])

  return status
}

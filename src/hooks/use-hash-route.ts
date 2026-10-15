import { useSyncExternalStore } from "react"
import { parseRoute, type AppRoute } from "@/lib/routes"

const subscribe = (notify: () => void) => {
  window.addEventListener("hashchange", notify)
  return () => window.removeEventListener("hashchange", notify)
}

/** Current page from the URL hash (#/, #/orders, #/simulator) */
export function useHashRoute(): AppRoute {
  return useSyncExternalStore(subscribe, () => parseRoute(window.location.hash))
}

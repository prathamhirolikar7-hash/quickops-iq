import { useEffect, useState } from "react"
import { useAuth } from "@/auth/auth-context"
import { AppHeader } from "@/components/layout/app-header"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { useAnalyticsStatus } from "@/hooks/use-analytics-status"
import { useDashboardRole } from "@/hooks/use-dashboard-role"
import { useHashRoute } from "@/hooks/use-hash-route"
import { useLiveRefresh } from "@/hooks/use-live-refresh"
import { ROUTE_TITLES } from "@/lib/routes"
import { cn } from "@/lib/utils"
import { ExecutiveOverview } from "@/pages/executive-overview"
import { OrdersPage } from "@/pages/orders-page"
import { SimulatorPage } from "@/pages/simulator-page"
import { useSimulator } from "@/simulator/simulator-context"
import { SimulatorProvider } from "@/simulator/simulator-provider"
import { DEFAULT_FILTERS, type DashboardFilters } from "@/types/dashboard"

const SIDEBAR_KEY = "quickops:sidebar-collapsed"

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1"
  } catch {
    return false
  }
}

/** The signed-in, approved dashboard (sidebar + header + routed page) */
export function DashboardShell() {
  const { user } = useAuth()
  const role = useDashboardRole(user?.id ?? null)
  // The simulator loop exists only for operators; the database re-checks every call
  return (
    <SimulatorProvider enabled={role.data === "operator"}>
      <ShellLayout isOperator={role.data === "operator"} />
    </SimulatorProvider>
  )
}

function ShellLayout({ isOperator }: { isOperator: boolean }) {
  const { user, signOut } = useAuth()
  const route = useHashRoute()
  const simulator = useSimulator()
  const status = useAnalyticsStatus()
  // Only approved members reach this shell, so only they ever subscribe
  const liveStatus = useLiveRefresh()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  // Shared across pages so switching pages keeps the date/city/store selection
  const [filters, setFilters] = useState<DashboardFilters>(DEFAULT_FILTERS)

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0")
    } catch {
      // storage unavailable (private mode): preference just won't persist
    }
  }, [collapsed])

  // Close the mobile drawer with Escape
  useEffect(() => {
    if (!mobileNavOpen) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMobileNavOpen(false)
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [mobileNavOpen])

  // Page title and scroll position follow the route
  useEffect(() => {
    document.title = `${ROUTE_TITLES[route]} · QuickOps IQ`
    window.scrollTo({ top: 0 })
  }, [route])

  return (
    <div className="min-h-svh">
      <AppSidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
        activeRoute={route}
        isOperator={isOperator}
        simulatorRunning={simulator.state === "running"}
      />
      <div
        className={cn(
          "flex min-h-svh min-w-0 flex-col transition-[padding] duration-300 ease-out",
          collapsed ? "lg:pl-[72px]" : "lg:pl-64",
        )}
      >
        <AppHeader
          onOpenMobileNav={() => setMobileNavOpen(true)}
          lastUpdated={status.lastUpdated}
          refreshing={status.fetching}
          onRefresh={status.refresh}
          userEmail={user?.email}
          onSignOut={signOut}
          liveStatus={liveStatus}
          pageTitle={ROUTE_TITLES[route]}
        />
        <main className="min-w-0 flex-1">
          {route === "orders" ? (
            <OrdersPage filters={filters} onFiltersChange={setFilters} />
          ) : route === "simulator" ? (
            <SimulatorPage />
          ) : (
            <ExecutiveOverview filters={filters} onFiltersChange={setFilters} />
          )}
        </main>
      </div>
    </div>
  )
}

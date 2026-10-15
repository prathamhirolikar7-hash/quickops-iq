import type { LucideIcon } from "lucide-react"
import {
  Boxes,
  FileText,
  FlaskConical,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShoppingBag,
  Store,
  Timer,
  Users,
  X,
  Zap,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { routeHref, type AppRoute } from "@/lib/routes"
import { cn } from "@/lib/utils"

interface NavItem {
  label: string
  icon: LucideIcon
  route?: AppRoute
  soon?: boolean
  operatorOnly?: boolean
}

const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Analytics",
    items: [
      { label: "Executive Overview", icon: LayoutDashboard, route: "overview" },
      { label: "Orders", icon: ShoppingBag, route: "orders" },
      { label: "Delivery & SLA", icon: Timer, soon: true },
      { label: "Dark Stores", icon: Store, soon: true },
      { label: "Inventory", icon: Boxes, soon: true },
      { label: "Customers", icon: Users, soon: true },
    ],
  },
  {
    title: "Workspace",
    items: [
      { label: "Simulator", icon: FlaskConical, route: "simulator", operatorOnly: true },
      { label: "Reports", icon: FileText, soon: true },
      { label: "Settings", icon: Settings, soon: true },
    ],
  },
]

interface AppSidebarProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  mobileOpen: boolean
  onMobileClose: () => void
  activeRoute: AppRoute
  isOperator: boolean
  simulatorRunning: boolean
}

export function AppSidebar({
  collapsed, onToggleCollapsed, mobileOpen, onMobileClose, activeRoute, isOperator, simulatorRunning,
}: AppSidebarProps) {
  return (
    <>
      {/* Mobile overlay */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity lg:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onMobileClose}
        aria-hidden
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-300 ease-out",
          "w-64 lg:translate-x-0",
          collapsed ? "lg:w-[72px]" : "lg:w-64",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
        aria-label="Main navigation"
      >
        {/* Brand */}
        <div className={cn("flex h-16 shrink-0 items-center gap-2.5 px-4", collapsed && "lg:justify-center lg:px-0")}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 shadow-lg shadow-violet-900/40">
            <Zap className="size-[18px] fill-white text-white" aria-hidden />
          </div>
          <div className={cn("min-w-0 flex-1", collapsed && "lg:hidden")}>
            <p className="text-[15px] leading-tight font-semibold tracking-tight text-foreground">
              QuickOps <span className="text-primary">IQ</span>
            </p>
            <p className="text-[11px] text-muted-foreground">Quick-commerce analytics</p>
          </div>
          <button
            type="button"
            onClick={onMobileClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground lg:hidden"
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="scrollbar-thin flex-1 space-y-6 overflow-y-auto px-3 py-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              <p
                className={cn(
                  "mb-2 px-3 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase",
                  collapsed && "lg:sr-only",
                )}
              >
                {section.title}
              </p>
              <ul className="space-y-1">
                {section.items
                  .filter((item) => !item.operatorOnly || isOperator)
                  .map((item) => (
                    <li key={item.label}>
                      <NavLink
                        item={item}
                        collapsed={collapsed}
                        active={item.route === activeRoute}
                        pulse={item.route === "simulator" && simulatorRunning}
                        onNavigate={onMobileClose}
                      />
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="shrink-0 space-y-3 border-t border-sidebar-border p-3">
          <div
            className={cn(
              "rounded-lg border border-primary/20 bg-gradient-to-br from-primary/15 to-transparent p-3",
              collapsed && "lg:hidden",
            )}
          >
            <p className="text-xs font-semibold text-foreground">Connected · Supabase</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Live database of synthetic orders for a fictional company.
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(
              "hidden h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground lg:flex",
              collapsed && "justify-center px-0",
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>
    </>
  )
}

function NavLink({ item, collapsed, active, pulse, onNavigate }: {
  item: NavItem
  collapsed: boolean
  active: boolean
  pulse: boolean
  onNavigate: () => void
}) {
  const Icon = item.icon
  const link = (
    <a
      href={item.route && !item.soon ? routeHref(item.route) : undefined}
      aria-current={active ? "page" : undefined}
      aria-disabled={item.soon || undefined}
      className={cn(
        "group/nav relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
        active
          ? "bg-primary/15 text-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-foreground",
        item.soon && "cursor-not-allowed",
        collapsed && "lg:justify-center lg:px-0",
      )}
      onClick={(e) => (item.soon ? e.preventDefault() : onNavigate())}
    >
      {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r-full bg-primary" aria-hidden />}
      <span className="relative">
        <Icon className={cn("size-[18px] shrink-0", active ? "text-primary" : "text-muted-foreground group-hover/nav:text-foreground")} />
        {pulse && <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-success" aria-label="Simulation running" />}
      </span>
      <span className={cn("flex-1 truncate", collapsed && "lg:hidden")}>{item.label}</span>
      {item.soon && (
        <span
          className={cn(
            "rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
            collapsed && "lg:hidden",
          )}
        >
          Soon
        </span>
      )}
    </a>
  )

  if (!collapsed) return link
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">
        {item.label}
        {item.soon && " · coming soon"}
      </TooltipContent>
    </Tooltip>
  )
}

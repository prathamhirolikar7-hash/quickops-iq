import { Bell, ChevronDown, ChevronRight, LogOut, Menu, RefreshCw, Search, Settings, User } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DataBadge } from "@/components/dashboard/data-badge"
import { formatTime } from "@/lib/format"
import type { LiveStatus } from "@/lib/live-refresh"
import { cn } from "@/lib/utils"

interface AppHeaderProps {
  onOpenMobileNav: () => void
  lastUpdated?: string
  refreshing?: boolean
  onRefresh: () => void
  userEmail?: string
  onSignOut: () => void
  liveStatus: LiveStatus
  pageTitle: string
}

const LIVE_STATUS_UI: Record<LiveStatus, { label: string; dot: string; ping: boolean; title: string }> = {
  live: { label: "Live", dot: "bg-success", ping: true, title: "Live updates on: the dashboard refreshes when orders or refunds change" },
  connecting: { label: "Connecting", dot: "bg-warning", ping: false, title: "Connecting to live updates…" },
  reconnecting: { label: "Reconnecting", dot: "bg-warning", ping: true, title: "Live updates interrupted; reconnecting. Refreshing every minute meanwhile." },
  unavailable: { label: "Auto-refresh", dot: "bg-muted-foreground", ping: false, title: "Live updates unavailable; refreshing every minute instead" },
  stopped: { label: "Paused", dot: "bg-muted-foreground", ping: false, title: "Live updates stopped" },
}

function LiveStatusPill({ status, lastUpdated }: { status: LiveStatus; lastUpdated?: string }) {
  const ui = LIVE_STATUS_UI[status]
  return (
    <div
      className="hidden shrink-0 items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground md:flex"
      title={ui.title}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex size-2" aria-hidden>
        {ui.ping && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", ui.dot)} />}
        <span className={cn("relative inline-flex size-2 rounded-full", ui.dot)} />
      </span>
      <span>
        <span className={cn("font-medium", status === "live" ? "text-success" : "text-foreground/80")}>{ui.label}</span>
        {" · "}
        {lastUpdated ? `Updated ${formatTime(lastUpdated)}` : "Loading…"}
      </span>
    </div>
  )
}

export function AppHeader({
  onOpenMobileNav, lastUpdated, refreshing, onRefresh, userEmail, onSignOut, liveStatus, pageTitle,
}: AppHeaderProps) {
  const displayName = userEmail?.split("@")[0] ?? "Signed in"
  const initials = (displayName.replace(/[^a-zA-Z]/g, "").slice(0, 2) || "QI").toUpperCase()
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/75 px-4 backdrop-blur-xl sm:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobileNav} aria-label="Open navigation">
        <Menu />
      </Button>
      <span className="text-[15px] font-semibold tracking-tight text-foreground sm:hidden">
        QuickOps <span className="text-primary">IQ</span>
      </span>

      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm sm:flex">
        <span className="text-muted-foreground">Dashboards</span>
        <ChevronRight className="size-3.5 text-muted-foreground/60" aria-hidden />
        <span className="truncate font-medium text-foreground">{pageTitle}</span>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <div className="relative hidden lg:block">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            placeholder="Search stores, metrics…"
            aria-label="Search"
            className="h-9 w-56 rounded-lg border border-input bg-card/60 pr-12 pl-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 xl:w-72"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-border bg-muted px-1.5 text-[10px] text-muted-foreground">
            Ctrl K
          </kbd>
        </div>

        <LiveStatusPill status={liveStatus} lastUpdated={lastUpdated} />

        <DataBadge className="hidden sm:inline-flex" />

        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon" onClick={onRefresh} aria-label="Refresh data" disabled={refreshing} />}
          >
            <RefreshCw className={cn(refreshing && "animate-spin")} />
          </TooltipTrigger>
          <TooltipContent>Refresh data</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon" className="relative" aria-label="Notifications" />}>
            <Bell />
            <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-background" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>Notifications</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" className="h-9 gap-2 pr-1.5 pl-1" aria-label="Account menu" />}
          >
            <Avatar size="sm" className="size-7">
              <AvatarFallback className="bg-primary/20 text-[11px] font-semibold text-primary">{initials}</AvatarFallback>
            </Avatar>
            <span className="hidden max-w-36 text-left leading-tight xl:block">
              <span className="block truncate text-xs font-medium text-foreground">{displayName}</span>
              <span className="block text-[10px] text-muted-foreground">Dashboard member</span>
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">Signed in as {userEmail ?? "—"}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <User /> Profile
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Settings /> Preferences
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

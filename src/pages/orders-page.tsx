import { useEffect, useState, type ReactNode } from "react"
import { ArrowDownUp, ChevronLeft, ChevronRight, ListFilter, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { DataBadge } from "@/components/dashboard/data-badge"
import { FilterBar } from "@/components/dashboard/filter-bar"
import { EmptyState, ErrorState } from "@/components/dashboard/state-views"
import { useOrdersPage } from "@/hooks/use-analytics"
import { useDashboardScope } from "@/hooks/use-dashboard-scope"
import { OPEN_STATUSES, type OrderSortBy, type OrderStatus, type OrdersPageParams } from "@/lib/analytics"
import { formatCurrency, formatNumber } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { DashboardFilters } from "@/types/dashboard"

const PAGE_SIZE = 25

const STATUS_FILTERS: { value: string; label: string; statuses: OrderStatus[] | null }[] = [
  { value: "all", label: "All statuses", statuses: null },
  { value: "open", label: "In progress", statuses: OPEN_STATUSES },
  { value: "delivered", label: "Delivered", statuses: ["delivered"] },
  { value: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
  { value: "out_for_delivery", label: "Out for delivery", statuses: ["out_for_delivery"] },
]

const SORTS: { value: string; label: string; by: OrderSortBy; dir: "asc" | "desc" }[] = [
  { value: "newest", label: "Newest first", by: "placed_at", dir: "desc" },
  { value: "oldest", label: "Oldest first", by: "placed_at", dir: "asc" },
  { value: "total_desc", label: "Highest total", by: "total", dir: "desc" },
  { value: "total_asc", label: "Lowest total", by: "total", dir: "asc" },
  { value: "slowest", label: "Slowest delivery", by: "delivery_time", dir: "desc" },
  { value: "fastest", label: "Fastest delivery", by: "delivery_time", dir: "asc" },
  { value: "number", label: "Order number", by: "order_number", dir: "asc" },
]

const STATUS_UI: Record<OrderStatus, { label: string; className: string }> = {
  placed: { label: "Placed", className: "bg-muted text-foreground/80" },
  confirmed: { label: "Confirmed", className: "bg-primary/10 text-primary" },
  picking: { label: "Picking", className: "bg-warning/10 text-warning" },
  packed: { label: "Packed", className: "bg-warning/10 text-warning" },
  out_for_delivery: { label: "Out for delivery", className: "bg-chart-2/15 text-chart-2" },
  delivered: { label: "Delivered", className: "bg-success/10 text-success" },
  cancelled: { label: "Cancelled", className: "bg-destructive/10 text-destructive" },
}

const istDateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
})

interface OrdersPageProps {
  filters: DashboardFilters
  onFiltersChange: (next: DashboardFilters) => void
}

export function OrdersPage({ filters, onFiltersChange }: OrdersPageProps) {
  const { freshness, period, scope, scopeLabel, filterBarProps } = useDashboardScope(filters)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [sort, setSort] = useState("newest")
  const [pageState, setPageState] = useState({ key: "", page: 0 })

  // Debounce typing so the server is queried at most every 350 ms
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.slice(0, 64)), 350)
    return () => clearTimeout(t)
  }, [searchInput])

  // Any change to what is being listed starts again at page 1 (derived, no effect needed)
  const listKey = [scope?.start, scope?.end, scope?.cityId, scope?.storeId, search, statusFilter, sort].join("|")
  const page = pageState.key === listKey ? pageState.page : 0
  const setPage = (update: (p: number) => number) => setPageState({ key: listKey, page: update(page) })

  const sortDef = SORTS.find((s) => s.value === sort)!
  const params: OrdersPageParams = {
    statuses: STATUS_FILTERS.find((f) => f.value === statusFilter)!.statuses,
    search,
    sortBy: sortDef.by,
    sortDir: sortDef.dir,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }
  const orders = useOrdersPage(scope, params)
  const rows = orders.data ?? []
  const total = rows.length ? Number(rows[0].total_count) : 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const refreshing = orders.isFetching && orders.isPlaceholderData

  if (freshness.isError) {
    return (
      <Frame>
        <ErrorState onRetry={() => freshness.refetch()} />
      </Frame>
    )
  }

  return (
    <Frame>
      <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">Orders</h1>
            <DataBadge className="sm:hidden" />
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every order with its live status
            {period && (
              <>
                {" · "}
                <span className="text-foreground/80">{period.label}, {scopeLabel}</span>
              </>
            )}
            {" · "}updates automatically when orders change
          </p>
        </div>
        <FilterBar value={filters} onChange={onFiltersChange} {...filterBarProps} />
      </div>

      <Card className="gap-4 border-0">
        <CardHeader>
          <CardTitle className="text-[15px] font-semibold">Order list</CardTitle>
          <CardDescription className="text-xs">
            {orders.isPending ? "Loading…" : `${formatNumber(total)} order${total === 1 ? "" : "s"} match`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Controls */}
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                maxLength={64}
                placeholder="Search order number, store code or locality…"
                aria-label="Search orders"
                className="h-9 w-full rounded-lg border border-input bg-card/60 pr-3 pl-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
              />
            </div>
            <MiniSelect icon={ListFilter} label="Status" value={statusFilter} onChange={setStatusFilter}
              options={STATUS_FILTERS.map(({ value, label }) => ({ value, label }))} />
            <MiniSelect icon={ArrowDownUp} label="Sort" value={sort} onChange={setSort}
              options={SORTS.map(({ value, label }) => ({ value, label }))} />
          </div>

          {/* Table */}
          {orders.isPending ? (
            <div className="space-y-2.5" aria-label="Loading orders">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : orders.isError && !orders.data ? (
            <ErrorState onRetry={() => orders.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No orders found"
              description={search ? `Nothing matches “${search}” in this selection.` : "No orders in this selection."}
            />
          ) : (
            <div className={cn("scrollbar-thin -mx-4 overflow-x-auto px-4 transition-opacity", refreshing && "opacity-60")}>
              <table className="w-full min-w-[920px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="pb-2.5 font-medium">Order</th>
                    <th scope="col" className="pb-2.5 font-medium">Placed (IST)</th>
                    <th scope="col" className="pb-2.5 font-medium">Status</th>
                    <th scope="col" className="pb-2.5 font-medium">Store</th>
                    <th scope="col" className="pb-2.5 text-right font-medium">Items</th>
                    <th scope="col" className="pb-2.5 text-right font-medium">Total</th>
                    <th scope="col" className="pb-2.5 text-right font-medium">Delivery</th>
                    <th scope="col" className="pb-2.5 pl-6 font-medium">SLA</th>
                    <th scope="col" className="pb-2.5 font-medium">Rider</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {rows.map((o) => (
                    <tr key={o.order_id} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                      <td className="py-2.5 font-medium text-foreground">{o.order_number}</td>
                      <td className="py-2.5 text-muted-foreground">{istDateTime.format(new Date(o.placed_at))}</td>
                      <td className="py-2.5">
                        <span className={cn("inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium", STATUS_UI[o.status].className)}
                          title={o.cancellation_reason ? `Reason: ${o.cancellation_reason.replace(/_/g, " ")}` : undefined}>
                          {STATUS_UI[o.status].label}
                        </span>
                      </td>
                      <td className="py-2.5 text-muted-foreground">
                        <span className="text-foreground/90">{o.store_code}</span> · {o.city_name}
                      </td>
                      <td className="py-2.5 text-right">{o.items_count}</td>
                      <td className="py-2.5 text-right font-medium">{formatCurrency(Number(o.total_paise) / 100)}</td>
                      <td className="py-2.5 text-right">{o.delivery_minutes == null ? "—" : `${Number(o.delivery_minutes).toFixed(1)} min`}</td>
                      <td className="py-2.5 pl-6">
                        {o.sla_met == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : o.sla_met ? (
                          <span className="text-success">On time</span>
                        ) : (
                          <span className="text-destructive">Late</span>
                        )}
                      </td>
                      <td className="py-2.5 text-muted-foreground">{o.rider_name ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {total > 0 && (
            <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground sm:flex-row">
              <span>
                Showing {formatNumber(page * PAGE_SIZE + 1)}–{formatNumber(Math.min(total, (page + 1) * PAGE_SIZE))} of {formatNumber(total)}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft data-icon="inline-start" /> Previous
                </Button>
                <span>Page {page + 1} of {formatNumber(pages)}</span>
                <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                  Next <ChevronRight data-icon="inline-end" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </Frame>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:py-8">{children}</div>
}

function MiniSelect({ icon: Icon, label, value, onChange, options }: {
  icon: typeof Search
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <Select items={options} value={value} onValueChange={(v) => typeof v === "string" && onChange(v)}>
      <SelectTrigger aria-label={label} className="h-9 w-full gap-2 bg-card/60 md:w-auto md:min-w-48 dark:bg-card/60 data-[size=default]:h-9">
        <Icon className="size-4 text-primary" aria-hidden />
        <span className="text-xs text-muted-foreground">{label}</span>
        <SelectValue className="font-medium" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        <SelectGroup>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

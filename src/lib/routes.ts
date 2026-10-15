// Hash routes: #/ (overview), #/orders, #/simulator. No router dependency.
export type AppRoute = "overview" | "orders" | "simulator"

export const ROUTE_TITLES: Record<AppRoute, string> = {
  overview: "Executive Overview",
  orders: "Orders",
  simulator: "Order Simulator",
}

export function parseRoute(hash: string): AppRoute {
  const path = hash.replace(/^#\/?/, "").split(/[?/]/)[0].toLowerCase()
  if (path === "orders") return "orders"
  if (path === "simulator") return "simulator"
  return "overview"
}

export function routeHref(route: AppRoute): string {
  return route === "overview" ? "#/" : `#/${route}`
}

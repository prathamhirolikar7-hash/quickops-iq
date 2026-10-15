import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AuthProvider } from "@/auth/auth-provider"
import { SetupRequired } from "@/components/auth/gate-screens"
import { TooltipProvider } from "@/components/ui/tooltip"
import { isAccessDenied, isInvalidRequest } from "@/lib/analytics"
import { supabaseConfigProblem } from "@/lib/supabase"
import "./index.css"
import App from "./App.tsx"

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    // 42501 from any analytics call means approval was revoked mid-session:
    // re-check access so the gate shows "awaiting approval" instead of data.
    onError: (error) => {
      if (isAccessDenied(error)) queryClient.invalidateQueries({ queryKey: ["access"] })
    },
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Never retry permission or validation errors; retry network/server errors once
      retry: (failureCount, error) => !isAccessDenied(error) && !isInvalidRequest(error) && failureCount < 1,
    },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={200}>
        {supabaseConfigProblem ? (
          <SetupRequired problem={supabaseConfigProblem} />
        ) : (
          <AuthProvider>
            <App />
          </AuthProvider>
        )}
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)

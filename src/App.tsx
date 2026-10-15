import { useAuth } from "@/auth/auth-context"
import { AccessCheckFailed, AccessPending, LoadingScreen } from "@/components/auth/gate-screens"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { useDashboardAccess } from "@/hooks/use-dashboard-access"
import { SignInPage } from "@/pages/sign-in"

/**
 * Access gate (UX only; the database enforces security):
 *   no session -> sign in
 *   session but not on the allowlist -> "awaiting approval"
 *   approved member -> dashboard
 */
export default function App() {
  const auth = useAuth()
  const access = useDashboardAccess(auth.user?.id ?? null)

  if (auth.status === "loading") return <LoadingScreen message="Checking your session…" />
  if (auth.status === "signed_out") return <SignInPage />
  if (access.isPending) return <LoadingScreen message="Checking dashboard access…" />
  if (access.isError) return <AccessCheckFailed onRetry={() => access.refetch()} onSignOut={auth.signOut} />
  if (!access.data) {
    return (
      <AccessPending
        email={auth.user?.email}
        checking={access.isFetching}
        onRecheck={() => access.refetch()}
        onSignOut={auth.signOut}
      />
    )
  }
  return <DashboardShell />
}

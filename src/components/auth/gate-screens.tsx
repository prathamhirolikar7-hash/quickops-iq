import type { ReactNode } from "react"
import { AlertTriangle, Hourglass, KeyRound, Loader2, LogOut, RefreshCw, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { SupabaseConfigProblem } from "@/lib/supabase"

/** Centered card on the dashboard background, used for every pre-dashboard state */
export function GateShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 shadow-lg shadow-violet-900/40">
            <Zap className="size-5 fill-white text-white" aria-hidden />
          </div>
          <div>
            <p className="text-lg leading-tight font-semibold tracking-tight text-foreground">
              QuickOps <span className="text-primary">IQ</span>
            </p>
            <p className="text-xs text-muted-foreground">Quick-commerce analytics</p>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6 shadow-2xl shadow-black/30 sm:p-8">{children}</div>
      </div>
    </main>
  )
}

function GateIcon({ children, tone = "primary" }: { children: ReactNode; tone?: "primary" | "warning" | "destructive" }) {
  const tones = {
    primary: "bg-primary/10 text-primary ring-primary/20",
    warning: "bg-warning/10 text-warning ring-warning/20",
    destructive: "bg-destructive/10 text-destructive ring-destructive/20",
  }
  return <div className={`mb-4 flex size-11 items-center justify-center rounded-full ring-1 ${tones[tone]}`}>{children}</div>
}

export function LoadingScreen({ message = "Loading…" }: { message?: string }) {
  return (
    <main className="flex min-h-svh items-center justify-center" aria-busy="true">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
        {message}
      </div>
    </main>
  )
}

const CONFIG_MESSAGES: Record<SupabaseConfigProblem, { title: string; body: string }> = {
  missing: {
    title: "Supabase connection not configured",
    body: "Create a .env.local file in the project root with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then restart the dev server.",
  },
  invalid_url: {
    title: "Invalid Supabase URL",
    body: "VITE_SUPABASE_URL must be your project's https URL, e.g. https://<project-ref>.supabase.co.",
  },
  secret_key: {
    title: "Secret key detected: refusing to start",
    body: "The configured key is a service-role / secret key. It bypasses all security and must never be used in the browser. Use the publishable (anon) key instead, and rotate the secret key if it was shared.",
  },
}

export function SetupRequired({ problem }: { problem: SupabaseConfigProblem }) {
  const msg = CONFIG_MESSAGES[problem]
  return (
    <GateShell>
      <GateIcon tone={problem === "secret_key" ? "destructive" : "warning"}>
        <AlertTriangle className="size-5" aria-hidden />
      </GateIcon>
      <h1 className="text-lg font-semibold text-foreground">{msg.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{msg.body}</p>
      <pre className="mt-4 rounded-lg border border-border bg-background/60 p-3 text-xs break-all whitespace-pre-wrap text-muted-foreground">
        {"VITE_SUPABASE_URL=https://<project-ref>.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=<publishable or anon key>"}
      </pre>
    </GateShell>
  )
}

export function AccessPending({ email, onRecheck, onSignOut, checking }: {
  email: string | undefined
  onRecheck: () => void
  onSignOut: () => void
  checking: boolean
}) {
  return (
    <GateShell>
      <GateIcon tone="warning">
        <Hourglass className="size-5" aria-hidden />
      </GateIcon>
      <h1 className="text-lg font-semibold text-foreground">Awaiting dashboard approval</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        You're signed in as <span className="font-medium text-foreground">{email ?? "this account"}</span>, but this
        account hasn't been approved for QuickOps IQ yet. An administrator needs to add it to the dashboard allowlist.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={onRecheck} disabled={checking}>
          <RefreshCw className={checking ? "animate-spin" : undefined} data-icon="inline-start" />
          Check again
        </Button>
        <Button variant="outline" onClick={onSignOut}>
          <LogOut data-icon="inline-start" />
          Sign out
        </Button>
      </div>
    </GateShell>
  )
}

export function AccessCheckFailed({ onRetry, onSignOut }: { onRetry: () => void; onSignOut: () => void }) {
  return (
    <GateShell>
      <GateIcon tone="destructive">
        <KeyRound className="size-5" aria-hidden />
      </GateIcon>
      <h1 className="text-lg font-semibold text-foreground">Couldn't verify dashboard access</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        The access check against Supabase failed. Check your connection and try again.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={onRetry}>
          <RefreshCw data-icon="inline-start" />
          Try again
        </Button>
        <Button variant="outline" onClick={onSignOut}>
          <LogOut data-icon="inline-start" />
          Sign out
        </Button>
      </div>
    </GateShell>
  )
}

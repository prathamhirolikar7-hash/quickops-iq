import { useState, type FormEvent } from "react"
import { Loader2, LockKeyhole, Mail } from "lucide-react"
import { useAuth } from "@/auth/auth-context"
import { GateShell } from "@/components/auth/gate-screens"
import { Button } from "@/components/ui/button"

const inputClass =
  "h-10 w-full rounded-lg border border-input bg-background/60 pr-3 pl-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"

export function SignInPage() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const result = await signIn(email, password)
    setSubmitting(false)
    if (result.error) setError(result.error)
  }

  return (
    <GateShell>
      <h1 className="text-xl font-semibold tracking-tight text-foreground">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">Access is limited to approved dashboard members.</p>

      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-xs font-medium text-muted-foreground">Email</label>
          <div className="relative">
            <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input id="email" type="email" autoComplete="email" required className={inputClass}
              placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-xs font-medium text-muted-foreground">Password</label>
          <div className="relative">
            <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input id="password" type="password" autoComplete="current-password" required className={inputClass}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="h-10 w-full" disabled={submitting || !email || !password}>
          {submitting && <Loader2 className="animate-spin" data-icon="inline-start" />}
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 text-center text-[11px] leading-relaxed text-muted-foreground/80">
        New accounts need approval by an administrator before any data is visible.
      </p>
    </GateShell>
  )
}

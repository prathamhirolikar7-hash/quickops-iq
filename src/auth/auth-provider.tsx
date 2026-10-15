import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Session } from "@supabase/supabase-js"
import { useQueryClient } from "@tanstack/react-query"
import { requireSupabase } from "@/lib/supabase"
import { AuthContext, type AuthContextValue } from "./auth-context"

/** Supabase Auth session state for the app (email + password sign-in). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const lastUserId = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    const client = requireSupabase()
    let active = true
    const apply = (next: Session | null) => {
      const id = next?.user.id ?? null
      // A different user (or none) must never see the previous user's cached data
      if (lastUserId.current !== undefined && lastUserId.current !== id) queryClient.clear()
      lastUserId.current = id
      setSession(next)
      setReady(true)
    }
    client.auth.getSession().then(({ data }) => {
      if (active) apply(data.session)
    })
    const { data } = client.auth.onAuthStateChange((_event, next) => apply(next))
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [queryClient])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await requireSupabase().auth.signInWithPassword({ email: email.trim(), password })
    return { error: error ? friendlyAuthError(error.message) : null }
  }, [])

  const signOut = useCallback(async () => {
    await requireSupabase().auth.signOut()
    queryClient.clear()
  }, [queryClient])

  const value = useMemo<AuthContextValue>(
    () => ({
      status: !ready ? "loading" : session ? "signed_in" : "signed_out",
      session,
      user: session?.user ?? null,
      signIn,
      signOut,
    }),
    [ready, session, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function friendlyAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) return "Incorrect email or password."
  if (/email not confirmed/i.test(message)) return "This email address has not been confirmed yet."
  if (/rate limit|too many/i.test(message)) return "Too many attempts. Please wait a minute and try again."
  return "Sign-in failed. Please try again."
}

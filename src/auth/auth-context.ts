import { createContext, useContext } from "react"
import type { Session, User } from "@supabase/supabase-js"

export interface AuthContextValue {
  status: "loading" | "signed_out" | "signed_in"
  session: Session | null
  user: User | null
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>")
  return ctx
}

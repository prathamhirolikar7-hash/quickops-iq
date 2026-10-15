import { createClient, type SupabaseClient } from "@supabase/supabase-js"

/**
 * Browser Supabase client.
 *
 * Only the project URL and the PUBLISHABLE (anon) key belong here. Both are
 * public by design; RLS and the dashboard allowlist enforce access. The
 * database password and service-role / secret keys must never reach the
 * browser, so this module refuses to start if it is given one.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined

export type SupabaseConfigProblem = "missing" | "invalid_url" | "secret_key"

function findConfigProblem(): SupabaseConfigProblem | null {
  if (!url || !key) return "missing"
  try {
    if (new URL(url).protocol !== "https:") return "invalid_url"
  } catch {
    return "invalid_url"
  }
  if (key.startsWith("sb_secret_")) return "secret_key"
  // Legacy JWT-style keys: reject anything whose role is service_role
  const parts = key.split(".")
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")))
      if (payload?.role === "service_role") return "secret_key"
    } catch {
      // Not a decodable JWT; the API will reject it if it is invalid
    }
  }
  return null
}

export const supabaseConfigProblem = findConfigProblem()

export const supabase: SupabaseClient | null = supabaseConfigProblem
  ? null
  : createClient(url!, key!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })

/** For code paths that only run after the config check has passed */
export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error("Supabase is not configured")
  return supabase
}

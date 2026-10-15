import { FlaskConical } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Persistent label: figures come live from the Supabase database, whose
 * records are a synthetic dataset for a fictional company.
 */
export function DataBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide whitespace-nowrap text-warning uppercase",
        className,
      )}
      title="Live data from Supabase. All records are synthetic and describe a fictional company."
    >
      <FlaskConical className="size-3.5" aria-hidden />
      Synthetic data
    </span>
  )
}

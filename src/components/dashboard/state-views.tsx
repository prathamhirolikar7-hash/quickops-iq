import type { LucideIcon } from "lucide-react"
import { AlertTriangle, Inbox } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface EmptyStateProps {
  title?: string
  description?: string
  icon?: LucideIcon
  className?: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({
  title = "No data for this selection",
  description = "Try a different city, store, or date range.",
  icon: Icon = Inbox,
  className,
  action,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-8 text-center",
        className,
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20">
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-xs text-xs text-muted-foreground">{description}</p>
      </div>
      {action && (
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Couldn't load dashboard data"
      description="Something went wrong while loading. Please try again."
      action={{ label: "Retry", onClick: onRetry }}
    />
  )
}

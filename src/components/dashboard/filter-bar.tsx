import type { LucideIcon } from "lucide-react"
import { CalendarDays, MapPin, RotateCcw, Store } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { DateRangeKey } from "@/lib/dates"
import { ALL, DEFAULT_FILTERS, type DashboardFilters } from "@/types/dashboard"

export interface FilterOption {
  value: string
  label: string
}

interface FilterBarProps {
  value: DashboardFilters
  onChange: (next: DashboardFilters) => void
  /** Cities from the database (without the "All" entry) */
  cities: FilterOption[]
  /** Stores from the database, each tagged with its city id */
  stores: (FilterOption & { cityId: string })[]
  /** Date presets with labels anchored on the latest data date */
  ranges: { value: DateRangeKey; label: string }[]
  disabled?: boolean
}

export function FilterBar({ value, onChange, cities, stores, ranges, disabled }: FilterBarProps) {
  const cityOptions = [{ value: ALL, label: "All cities" }, ...cities]
  const storeOptions = [
    { value: ALL, label: "All stores" },
    ...stores.filter((s) => value.city === ALL || s.cityId === value.city).map(({ value, label }) => ({ value, label })),
  ]
  const isDefault =
    value.city === DEFAULT_FILTERS.city && value.store === DEFAULT_FILTERS.store && value.range === DEFAULT_FILTERS.range

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" role="group" aria-label="Dashboard filters">
      <FilterSelect
        icon={MapPin}
        label="City"
        value={value.city}
        options={cityOptions}
        disabled={disabled}
        onChange={(city) => onChange({ ...value, city, store: ALL })}
      />
      <FilterSelect
        icon={Store}
        label="Store"
        value={value.store}
        options={storeOptions}
        disabled={disabled}
        onChange={(store) => onChange({ ...value, store })}
        widthClass="sm:min-w-72"
      />
      <FilterSelect
        icon={CalendarDays}
        label="Date range"
        value={value.range}
        options={ranges}
        disabled={disabled}
        onChange={(range) => onChange({ ...value, range: range as DateRangeKey })}
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-9 self-start text-muted-foreground sm:self-auto"
        disabled={isDefault || disabled}
        onClick={() => onChange(DEFAULT_FILTERS)}
      >
        <RotateCcw data-icon="inline-start" />
        Reset
      </Button>
    </div>
  )
}

interface FilterSelectProps {
  icon: LucideIcon
  label: string
  value: string
  options: FilterOption[]
  onChange: (value: string) => void
  widthClass?: string
  disabled?: boolean
}

function FilterSelect({ icon: Icon, label, value, options, onChange, widthClass = "sm:min-w-48", disabled }: FilterSelectProps) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next)
      }}
    >
      <SelectTrigger
        aria-label={label}
        className={`h-9 w-full gap-2 bg-card/60 sm:w-auto dark:bg-card/60 data-[size=default]:h-9 ${widthClass}`}
      >
        <Icon className="size-4 text-primary" aria-hidden />
        <span className="text-xs text-muted-foreground">{label}</span>
        <SelectValue className="font-medium" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        <SelectGroup>
          <SelectLabel>{label}</SelectLabel>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

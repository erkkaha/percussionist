// FilterBar.tsx — column filter tabs, search, type/priority filter chips.

import { Search, X, Plus } from "lucide-react";

const ALL_COLUMNS = ["ideas", "backlog", "blocked", "in-progress", "review", "done"] as const;
export type ColumnKey = (typeof ALL_COLUMNS)[number];

export interface FilterState {
  column: ColumnKey | "all";
  search: string;
  type: "all" | "PLAN" | "BUILD";
  priority: "all" | "high" | "medium" | "low";
}

interface FilterBarProps {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  columnCounts: Record<string, number>;
  onAddIdea?: () => void;
}

export function FilterBar({ filters, onChange, columnCounts, onAddIdea }: FilterBarProps) {
  return (
    <div className="space-y-2 shrink-0">
      {/* Column tabs — scrollable row */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-none">
        <button
          onClick={() => onChange({ ...filters, column: "all" })}
          className={`shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            filters.column === "all"
              ? "bg-[#5c4a3a] text-text"
              : "text-text-dim hover:text-text hover:bg-surface-overlay"
          }`}
        >
          All
          {" "}
          <span className="tabular-nums opacity-60">
            {Object.values(columnCounts).reduce((a, b) => a + b, 0)}
          </span>
        </button>
        {ALL_COLUMNS.map((col) => (
          <div key={col} className="flex items-center">
            <button
              onClick={() => onChange({ ...filters, column: col })}
              className={`shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                filters.column === col
                  ? "bg-[#5c4a3a] text-text"
                  : "text-text-dim hover:text-text hover:bg-surface-overlay"
              }`}
            >
              {col}
              {columnCounts[col] != null && columnCounts[col]! > 0 && (
                <span className="ml-1 tabular-nums opacity-60">{columnCounts[col]}</span>
              )}
            </button>
            {col === "ideas" && onAddIdea && (
              <button
                onClick={onAddIdea}
                className="ml-0.5 p-1 rounded text-text-dim hover:text-text hover:bg-surface-overlay transition-colors"
                title="Add idea"
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Search + type/priority chips */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[10rem]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-dim pointer-events-none" />
          <input
            type="text"
            placeholder="Search tasks…"
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            className="w-full rounded border border-border bg-surface-raised pl-7 pr-7 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-border"
          />
          {filters.search && (
            <button
              onClick={() => onChange({ ...filters, search: "" })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Type filter */}
        <div className="flex items-center gap-1">
          {(["all", "PLAN", "BUILD"] as const).map((t) => (
            <button
              key={t}
              onClick={() => onChange({ ...filters, type: t })}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                filters.type === t
                  ? "bg-surface-overlay text-text"
                  : "text-text-dim hover:text-text"
              }`}
            >
              {t === "all" ? "Any type" : t}
            </button>
          ))}
        </div>

        {/* Priority filter */}
        <div className="flex items-center gap-1">
          {(["all", "high", "medium", "low"] as const).map((p) => (
            <button
              key={p}
              onClick={() => onChange({ ...filters, priority: p })}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                filters.priority === p
                  ? "bg-surface-overlay text-text"
                  : "text-text-dim hover:text-text"
              }`}
            >
              {p === "all" ? "Any priority" : p}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

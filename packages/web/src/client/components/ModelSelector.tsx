// ModelSelector.tsx — Combobox-style model picker.
//
// Renders a text input (for manual entry) with a dropdown button that lists
// all available providers and their models, fetched from the opencode sidecar
// via GET /api/providers.
//
// Gracefully degrades to a plain text input when the sidecar is unreachable.

import { useState, useRef, useEffect, useCallback } from "react";
import { useProviders } from "../hooks/useProviders";
import { cn } from "../lib/utils";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

export default function ModelSelector({
  value,
  onChange,
  placeholder = "e.g. anthropic/claude-sonnet-4-20250514",
  className,
  inputClassName,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: providers, isLoading, isError } = useProviders();

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setFilter("");
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  function handleSelect(modelId: string) {
    onChange(modelId);
    setOpen(false);
    setFilter("");
    inputRef.current?.focus();
  }

  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      if (!v) setFilter("");
      return !v;
    });
  }, []);

  // Build filtered list: only connected providers.
  const connected = new Set(providers?.connected ?? []);
  const allProviders = (providers?.all ?? []).filter((p) => connected.has(p.id));

  const filtered = allProviders
    .map((p) => {
      const q = filter.toLowerCase();
      const modelList = Array.isArray(p.models)
        ? p.models
        : Object.values((p.models ?? {}) as Record<string, { id: string; name?: string }>);
      const models = modelList.filter(
        (m) =>
          !q ||
          m.id.toLowerCase().includes(q) ||
          (m.name ?? "").toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          (p.name ?? "").toLowerCase().includes(q),
      );
      return { ...p, models };
    })
    .filter((p) => p.models.length > 0)
    .sort((a, b) => {
      const ac = connected.has(a.id) ? 0 : 1;
      const bc = connected.has(b.id) ? 0 : 1;
      return ac - bc;
    });

  const hasProviders = allProviders.length > 0;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="flex gap-1">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(
            "flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-accent/60 focus:outline-none font-mono",
            inputClassName,
          )}
        />
        {/* Dropdown trigger — only shown when provider data is available (or loading) */}
        {!isError && (
          <button
            type="button"
            onClick={toggleOpen}
            title={isLoading ? "Loading models..." : "Browse available models"}
            className={cn(
              "flex items-center justify-center w-8 shrink-0 rounded-md border border-border bg-surface text-text-dim hover:text-text hover:border-accent/60 transition-colors focus:outline-none",
              open && "border-accent/60 text-text",
              isLoading && "opacity-50 cursor-wait",
            )}
            disabled={isLoading}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <svg
              className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")}
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 4l4 4 4-4" />
            </svg>
          </button>
        )}
      </div>

      {/* Dropdown panel */}
      {open && hasProviders && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 w-full min-w-[280px] rounded-md border border-border bg-surface-container-low shadow-xl overflow-hidden"
        >
          {/* Search filter */}
          <div className="p-2 border-b border-border">
            <input
              autoFocus
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter models..."
              className="w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-text placeholder:text-text-dim focus:border-accent/60 focus:outline-none"
            />
          </div>

          {/* Provider + model list */}
          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-xs text-text-dim text-center">No models match</p>
            ) : (
              filtered.map((provider) => {
                const isConnected = connected.has(provider.id);
                return (
                  <div key={provider.id}>
                    {/* Provider header */}
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-dim sticky top-0">
                      <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                        {provider.name ?? provider.id}
                      </span>
                      {isConnected ? (
                        <span className="text-caption-xs text-phase-running font-medium">connected</span>
                      ) : (
                        <span className="text-caption-xs text-text-dim">not connected</span>
                      )}
                    </div>
                    {/* Models */}
                    {provider.models.map((model) => {
                      const modelId = `${provider.id}/${model.id}`;
                      const isSelected = value === modelId;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => handleSelect(modelId)}
                          className={cn(
                            "w-full text-left px-3 py-2 flex items-center justify-between gap-3 hover:bg-surface-container-low transition-colors",
                            isSelected && "bg-accent/10 text-accent",
                            !isConnected && "opacity-50",
                          )}
                        >
                          <span className="font-mono text-xs text-text truncate">
                            {model.id}
                          </span>
                          {(model.name && model.name !== model.id) && (
                            <span className="text-xs text-text-dim shrink-0 truncate max-w-[120px]">
                              {model.name}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer hint */}
          <div className="px-3 py-1.5 border-t border-border">
            <p className="text-caption-xs text-text-dim">
              Connected providers shown first. You can also type any model ID directly.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

import * as React from "react";
import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Context — shared state between Tabs, TabsList, TabsTrigger, TabsContent
// ---------------------------------------------------------------------------

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (value: string) => void;
  orientation: "horizontal" | "vertical";
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs() {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error("Tabs components must be used within a <Tabs>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Tabs — root provider with controlled or uncontrolled state
// ---------------------------------------------------------------------------

interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Active tab ID (controlled). Use together with `onValueChange` for full control. */
  value?: string;
  /** Default active tab ID (uncontrolled). Ignored if `value` is provided. */
  defaultValue?: string;
  /** Callback when the active tab changes. */
  onValueChange?: (value: string) => void;
  /** Tab orientation — horizontal (default) or vertical. */
  orientation?: "horizontal" | "vertical";
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ value, defaultValue, onValueChange, orientation = "horizontal", className, children, ...props }, ref) => {
    const [internalActiveTab, setInternalActiveTab] = React.useState(() => defaultValue ?? "");
    const activeTab = value !== undefined ? value : internalActiveTab;

    function setActiveTab(next: string) {
      if (value === undefined) setInternalActiveTab(next);
      onValueChange?.(next);
    }

    return (
      <TabsContext.Provider value={{ activeTab, setActiveTab, orientation }}>
        <div
          ref={ref}
          data-orientation={orientation}
          className={cn("data-[orientation=vertical]:flex", className)}
          {...props}
        >
          {children}
        </div>
      </TabsContext.Provider>
    );
  },
);
Tabs.displayName = "Tabs";

// ---------------------------------------------------------------------------
// TabsList — tab bar container with role="tablist"
// ---------------------------------------------------------------------------

interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {}

const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="tablist"
      aria-orientation={props["aria-orientation"] ?? "horizontal"}
      className={cn(
        "inline-flex items-center justify-center rounded-lg bg-surface-container-high p-1 text-text-dim",
        className,
      )}
      {...props}
    />
  ),
);
TabsList.displayName = "TabsList";

// ---------------------------------------------------------------------------
// TabsTrigger — individual tab button with ARIA + keyboard navigation
// ---------------------------------------------------------------------------

interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Unique identifier for this tab. */
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, children, ...props }, ref) => {
    const { activeTab, setActiveTab, orientation } = useTabs();
    const isActive = activeTab === value;

    // Keyboard navigation — arrow keys move focus between tabs
    function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
      const parent = e.currentTarget.parentElement;
      if (!parent) return;

      const triggers = Array.from(parent.querySelectorAll<HTMLElement>('[role="tab"]'));
      const idx = triggers.indexOf(e.currentTarget);
      let nextIdx = -1;

      if (orientation === "vertical") {
        // Up/Down arrows for vertical orientation
        if (e.key === "ArrowUp") nextIdx = idx > 0 ? idx - 1 : triggers.length - 1;
        else if (e.key === "ArrowDown") nextIdx = idx < triggers.length - 1 ? idx + 1 : 0;
      } else {
        // Left/Right arrows for horizontal orientation
        if (e.key === "ArrowLeft") nextIdx = idx > 0 ? idx - 1 : triggers.length - 1;
        else if (e.key === "ArrowRight") nextIdx = idx < triggers.length - 1 ? idx + 1 : 0;
      }

      // Home/End jump to first/last tab
      if (e.key === "Home") {
        e.preventDefault();
        triggers[0]?.focus();
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        triggers[triggers.length - 1]?.focus();
        return;
      }

      if (nextIdx >= 0) {
        e.preventDefault();
        triggers[nextIdx]?.focus();
      }
    }

    function handleSelect() {
      setActiveTab(value);
    }

    return (
      <button
        ref={ref}
        role="tab"
        aria-selected={isActive}
        aria-controls={`tabs-panel-${value}`}
        data-state={isActive ? "active" : "inactive"}
        data-value={value}
        onClick={handleSelect}
        onKeyDown={handleKeyDown}
        tabIndex={isActive ? 0 : -1}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40",
          isActive
            ? "bg-surface-container text-text shadow-sm"
            : "hover:bg-surface-overlay hover:text-text-muted",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

// ---------------------------------------------------------------------------
// TabsContent — content panel for the active tab
// ---------------------------------------------------------------------------

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Must match the `value` of a corresponding TabsTrigger. */
  value: string;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const { activeTab } = useTabs();
    if (activeTab !== value) return null;

    return (
      <div
        ref={ref}
        role="tabpanel"
        id={`tabs-panel-${value}`}
        data-state="active"
        data-value={value}
        tabIndex={0}
        className={cn("mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", className)}
        {...props}
      />
    );
  },
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };

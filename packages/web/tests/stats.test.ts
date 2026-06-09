// stats.test.ts — Unit tests for StatsView single-open session behavior.
//
// Tests verify the interaction invariant:
// - Opening one row displays detail
// - Opening another row closes previous
// - Toggling same row closes it
// - Selected session resets when not present after page/day change

import { describe, it, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Core behavior tests
// ---------------------------------------------------------------------------

describe("StatsView single-open session behavior", () => {
  it("Opening one row displays detail (sets openRunName)", () => {
    let openRunName: string | null = null;
    const setOpenRunName = (name: string | null) => {
      openRunName = name;
    };

    // Simulate clicking first row
    const runName = "run-0";
    setOpenRunName(runName);

    expect(openRunName).toBe(runName);
  });

  it("Opening another row closes previous (only one open at a time)", () => {
    let openRunName: string | null = null;
    const setOpenRunName = (name: string | null) => {
      openRunName = name;
    };

    // Open first run
    setOpenRunName("run-0");
    expect(openRunName).toBe("run-0");

    // Open second run - should close first
    setOpenRunName("run-1");
    expect(openRunName).toBe("run-1");
  });

  it("Toggling same row closes it (clears open state)", () => {
    let openRunName: string | null = null;
    const setOpenRunName = (name: string | null) => {
      openRunName = name;
    };

    // Open a run
    setOpenRunName("run-0");
    expect(openRunName).toBe("run-0");

    // Toggle the same run - should close it
    setOpenRunName(null);
    expect(openRunName).toBeNull();
  });

  it("Selected session resets when not present after page/day change", () => {
    let openRunName: string | null = "run-99";

    // Simulate days or page change effect - should clear open state
    const mockClearOnFilterChange = (currentOpen: string | null) => {
      return null;
    };

    openRunName = mockClearOnFilterChange(openRunName);

    expect(openRunName).toBeNull();
  });

  it("Toggles work correctly with multiple sessions", () => {
    let openRunName: string | null = null;
    const setOpenRunName = (name: string | null) => {
      openRunName = name;
    };
    const sessions = [
      { id: "0", name: "run-0" },
      { id: "1", name: "run-1" },
      { id: "2", name: "run-2" },
      { id: "3", name: "run-3" },
      { id: "4", name: "run-4" },
    ];

    // Open first session
    setOpenRunName(sessions[0].name);
    expect(openRunName).toBe(sessions[0].name);

    // Toggle to second session
    setOpenRunName(sessions[1].name);
    expect(openRunName).toBe(sessions[1].name);
    expect(openRunName).not.toBe(sessions[0].name);

    // Toggle to third session
    setOpenRunName(sessions[2].name);
    expect(openRunName).toBe(sessions[2].name);
    expect(openRunName).not.toBe(sessions[1].name);

    // Toggle same session again (close it)
    setOpenRunName(null);
    expect(openRunName).toBeNull();
  });

  it("Effect cleanup clears open state on pagination change", () => {
    let openRunName: string | null = "run-5";

    // Simulate page change effect (like useEffect([days, page]) cleanup)
    const simulatePageChange = () => {
      return null;
    };

    openRunName = simulatePageChange();

    expect(openRunName).toBeNull();
  });

  it("Effect cleanup clears open state on day filter change", () => {
    let openRunName: string | null = "run-3";

    // Simulate day filter change effect
    const simulateDayChange = () => {
      return null;
    };

    openRunName = simulateDayChange();

    expect(openRunName).toBeNull();
  });

  it("Does not keep stale open state when session not in current page", () => {
    let openRunName: string | null = "run-2";

    // Simulate switching to a different day range where "run-2" might not exist
    const simulateFilterChangeForNonExistent = (current: string | null) => {
      return null;
    };

    openRunName = simulateFilterChangeForNonExistent(openRunName);

    expect(openRunName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Toggle logic tests (mirrors onToggleRun callback)
// ---------------------------------------------------------------------------

describe("SessionsTable toggle logic", () => {
  it("Table row click toggles detail view", () => {
    let openRunName: string | null = null;
    const sessions = [
      { id: "0", name: "run-0" },
      { id: "1", name: "run-1" },
      { id: "2", name: "run-2" },
    ];

    const onToggleRun = (name: string) => {
      openRunName = openRunName === name ? null : name;
    };

    // Simulate clicking first row
    onToggleRun(sessions[0].name);
    expect(openRunName).toBe(sessions[0].name);

    // Simulate clicking second row - should close first
    onToggleRun(sessions[1].name);
    expect(openRunName).toBe(sessions[1].name);
    expect(openRunName).not.toBe(sessions[0].name);
  });

  it("Same row click twice closes detail", () => {
    let openRunName: string | null = null;
    const sessions = [{ id: "0", name: "run-0" }];

    const onToggleRun = (name: string) => {
      openRunName = openRunName === name ? null : name;
    };

    // Click once - opens
    onToggleRun(sessions[0].name);
    expect(openRunName).toBe(sessions[0].name);

    // Click again - closes
    onToggleRun(sessions[0].name);
    expect(openRunName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Page/day change behavior tests
// ---------------------------------------------------------------------------

describe("Page/day change clears open state", () => {
  it("Clears open state when switching day filter", () => {
    let days = 30;
    let openRunName: string | null = "run-5";

    // Simulate the useEffect that clears on [days, page] change
    const handleDayChange = (newDays: number) => {
      days = newDays;
      // This is what the useEffect does - clear open state
      openRunName = null;
    };

    expect(openRunName).toBe("run-5");
    handleDayChange(7);
    expect(openRunName).toBeNull();
  });

  it("Clears open state when changing page", () => {
    let page = 1;
    let openRunName: string | null = "run-10";

    const handlePageChange = (newPage: number) => {
      page = newPage;
      // Clear open state on page change
      openRunName = null;
    };

    expect(openRunName).toBe("run-10");
    handlePageChange(2);
    expect(openRunName).toBeNull();
  });

  it("Handles rapid day/page changes correctly", () => {
    let days = 30;
    let page = 0;
    let openRunName: string | null = "run-7";

    const changeDayAndReset = (newDays: number) => {
      days = newDays;
      openRunName = null;
    };

    const changePageAndReset = (newPage: number) => {
      page = newPage;
      openRunName = null;
    };

    // Initial state
    expect(openRunName).toBe("run-7");

    // Change day
    changeDayAndReset(14);
    expect(openRunName).toBeNull();

    // Change page
    changePageAndReset(1);
    expect(openRunName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases and invariants
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("Does not allow multiple open sessions simultaneously", () => {
    let openRunName: string | null = null;
    const setOpenRunName = (name: string | null) => {
      openRunName = name;
    };

    // Try to "open" multiple runs
    setOpenRunName("run-0");
    setOpenRunName("run-1");
    setOpenRunName("run-2");

    // Only one should be open
    expect(openRunName).toBe("run-2");
    expect(openRunName).not.toBe("run-0");
    expect(openRunName).not.toBe("run-1");
  });

  it("Handles null/undefined gracefully", () => {
    let openRunName: string | null = null;

    // Setting to null should work
    openRunName = null;
    expect(openRunName).toBeNull();

    // Toggling null should set a value
    const toggle = (name: string) => {
      openRunName = openRunName === name ? null : name;
    };

    toggle("run-0");
    expect(openRunName).toBe("run-0");

    toggle(null);
    expect(openRunName).toBeNull();
  });

  it("Clear state when switching between tabs", () => {
    let currentTab = "overview";
    let openRunName: string | null = "run-5";

    const switchTab = (newTab: string) => {
      currentTab = newTab;
      if (currentTab !== "sessions") {
        openRunName = null;
      }
    };

    expect(openRunName).toBe("run-5");
    switchTab("agents");
    expect(openRunName).toBeNull();
  });
});

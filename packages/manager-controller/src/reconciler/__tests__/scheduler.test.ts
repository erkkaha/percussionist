import { describe, it, expect } from "vitest";
import { canSchedule, byPriority, isActivePhase } from "../scheduler.js";
import { makeTask, makeProject } from "./fixtures.js";

describe("isActivePhase", () => {
  const activePhases = [
    "scheduled",
    "initializing",
    "running",
    "reviewing",
    "waiting-for-input",
    "awaiting-merge",
    "generating-builds",
  ] as const;

  const inactivePhases = [
    "idea",
    "pending",
    "succeeded",
    "awaiting-human",
    "rework-requested",
    "done",
    "failed",
  ] as const;

  it.each(activePhases)("returns true for %s", (phase) => {
    expect(isActivePhase(phase)).toBe(true);
  });

  it.each(inactivePhases)("returns false for %s", (phase) => {
    expect(isActivePhase(phase)).toBe(false);
  });
});

describe("canSchedule", () => {
  const project = makeProject("test-project", { maxParallel: 2 });

  it("schedules when capacity is available", () => {
    const task = makeTask("task-1", "test-project", { phase: "pending" });
    const allTasks: ReturnType<typeof makeTask>[] = [task];
    expect(canSchedule(task, project, allTasks, 0)).toBe(true);
  });

  it("blocks when activeCount >= maxParallel", () => {
    const task = makeTask("task-1", "test-project", { phase: "pending" });
    const allTasks: ReturnType<typeof makeTask>[] = [task];
    expect(canSchedule(task, project, allTasks, 2)).toBe(false);
    expect(canSchedule(task, project, allTasks, 3)).toBe(false);
  });

  it("schedules when activeCount < maxParallel", () => {
    const task = makeTask("task-1", "test-project", { phase: "pending" });
    const allTasks: ReturnType<typeof makeTask>[] = [task];
    expect(canSchedule(task, project, allTasks, 1)).toBe(true);
  });

  it("blocks when predecessor is not done", () => {
    const pred = makeTask("pred-1", "test-project", { phase: "running" });
    const task = makeTask("task-1", "test-project", {
      phase: "pending",
      predecessorRef: "pred-1",
    });
    const allTasks = [pred, task];
    expect(canSchedule(task, project, allTasks, 0)).toBe(false);
  });

  it("allows scheduling when predecessor is done", () => {
    const pred = makeTask("pred-1", "test-project", { phase: "done" });
    const task = makeTask("task-1", "test-project", {
      phase: "pending",
      predecessorRef: "pred-1",
    });
    const allTasks = [pred, task];
    expect(canSchedule(task, project, allTasks, 0)).toBe(true);
  });

  it("blocks when predecessor is done but not merged (feature branching)", () => {
    const fbProject = makeProject("test-project", {
      maxParallel: 2,
      featureBranchingEnabled: true,
    });
    const pred = makeTask("pred-1", "test-project", { phase: "done" });
    const task = makeTask("task-1", "test-project", {
      phase: "pending",
      predecessorRef: "pred-1",
    });
    const allTasks = [pred, task];
    expect(canSchedule(task, fbProject, allTasks, 0)).toBe(false);
  });

  it("allows scheduling when predecessor is done and merged (feature branching)", () => {
    const fbProject = makeProject("test-project", {
      maxParallel: 2,
      featureBranchingEnabled: true,
    });
    const pred = makeTask("pred-1", "test-project", {
      phase: "done",
      mergedAt: "2026-05-29T00:00:00.000Z",
    });
    const task = makeTask("task-1", "test-project", {
      phase: "pending",
      predecessorRef: "pred-1",
    });
    const allTasks = [pred, task];
    expect(canSchedule(task, fbProject, allTasks, 0)).toBe(true);
  });

  it("blocks when retryAfter is in the future", () => {
    const task = makeTask("task-1", "test-project", {
      phase: "pending",
      retryAfter: "2099-01-01T00:00:00.000Z",
    });
    const allTasks = [task];
    expect(canSchedule(task, project, allTasks, 0)).toBe(false);
  });

  it("allows scheduling when retryAfter is in the past", () => {
    const task = makeTask("task-1", "test-project", {
      phase: "pending",
      retryAfter: "2020-01-01T00:00:00.000Z",
    });
    const allTasks = [task];
    expect(canSchedule(task, project, allTasks, 0)).toBe(true);
  });

  it("blocks when predecessor is missing", () => {
    const task = makeTask("task-1", "test-project", {
      phase: "pending",
      predecessorRef: "nonexistent",
    });
    const allTasks = [task];
    expect(canSchedule(task, project, allTasks, 0)).toBe(false);
  });
});

describe("byPriority", () => {
  const project = "test-project";

  it("sorts high before medium before low", () => {
    const tasks = [
      makeTask("low", project, { priority: "low" }),
      makeTask("high", project, { priority: "high" }),
      makeTask("medium", project, { priority: "medium" }),
    ];
    tasks.sort(byPriority);
    expect(tasks.map((t) => t.metadata.name)).toEqual(["high", "medium", "low"]);
  });

  it("defaults to medium when priority is unset", () => {
    const a = makeTask("a", project);
    const b = makeTask("b", project, { priority: "high" });
    // byPriority(a, b) returns bP - aP: high(3) - medium(2) = 1 → b sorts first
    expect(byPriority(a, b)).toBe(1);
    expect(byPriority(b, a)).toBe(-1);
  });
});

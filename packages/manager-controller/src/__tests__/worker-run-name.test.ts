import { describe, it, expect } from "bun:test";
import { workerRunName } from "../worker-builder.js";

describe("workerRunName — determinism", () => {
  it("same inputs produce the same output", () => {
    const a = workerRunName("my-project", "build-123", 0, 0);
    const b = workerRunName("my-project", "build-123", 0, 0);
    expect(a).toBe(b);
  });

  it("different project names produce different outputs", () => {
    const a = workerRunName("proj-a", "task-x", 0, 0);
    const b = workerRunName("proj-b", "task-x", 0, 0);
    expect(a).not.toBe(b);
  });

  it("different task names produce different outputs", () => {
    const a = workerRunName("my-project", "task-a", 0, 0);
    const b = workerRunName("my-project", "task-b", 0, 0);
    expect(a).not.toBe(b);
  });

  it("different retryCount produces different outputs", () => {
    const a = workerRunName("my-project", "task-x", 0, 0);
    const b = workerRunName("my-project", "task-x", 1, 0);
    expect(a).not.toBe(b);
  });

  it("different aiReworkCount produces different outputs", () => {
    const a = workerRunName("my-project", "task-x", 0, 0);
    const b = workerRunName("my-project", "task-x", 0, 1);
    expect(a).not.toBe(b);
  });

  it("both counters changed produces different output from either alone", () => {
    const a = workerRunName("my-project", "task-x", 0, 0);
    const b = workerRunName("my-project", "task-x", 1, 1);
    expect(a).not.toBe(b);
  });
});

describe("workerRunName — aiReworkCount differentiation", () => {
  it("aiReworkCount=1 produces a distinct name from aiReworkCount=0 (same retryCount)", () => {
    const base = workerRunName("test-project", "build-abc", 2, 0);
    const reworked = workerRunName("test-project", "build-abc", 2, 1);
    expect(base).not.toBe(reworked);
  });

  it("multiple aiReworkCount values all produce unique names", () => {
    const names = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const name = workerRunName("test-project", "build-abc", 1, i);
      expect(names.has(name)).toBe(false);
      names.add(name);
    }
  });

  it("retryCount bump resets aiReworkCount to produce a different namespace", () => {
    // After human rework: retryCount bumps, aiReworkCount resets.
    const before = workerRunName("test-project", "build-abc", 0, 2);
    const after = workerRunName("test-project", "build-abc", 1, 0);
    expect(before).not.toBe(after);
  });

  it("aiReworkCount=3 and retryCount=1 are in distinct name spaces (no collision)", () => {
    // These should never collide because the hash input includes both counters.
    const a = workerRunName("test-project", "build-abc", 0, 3);
    const b = workerRunName("test-project", "build-abc", 1, 0);
    expect(a).not.toBe(b);
  });

  it("large aiReworkCount values still produce unique names", () => {
    const a = workerRunName("test-project", "task-x", 0, 999);
    const b = workerRunName("test-project", "task-x", 0, 1000);
    expect(a).not.toBe(b);
  });
});

describe("workerRunName — K8s name constraints (<=63 chars)", () => {
  it("short project + task produces <=63 char name", () => {
    const name = workerRunName("proj", "task", 0, 0);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("long project name still produces <=63 char name", () => {
    const longProject = "a".repeat(50);
    const name = workerRunName(longProject, "task", 0, 0);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("long task name still produces <=63 char name", () => {
    const longTask = "a".repeat(50);
    const name = workerRunName("proj", longTask, 0, 0);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("both project and task are long — still <=63 chars", () => {
    const longProject = "a".repeat(40);
    const longTask = "b".repeat(40);
    const name = workerRunName(longProject, longTask, 0, 0);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("name never ends with a hyphen", () => {
    for (let i = 0; i < 10; i++) {
      const name = workerRunName("test-project", "task-123", i, 0);
      expect(name.endsWith("-")).toBe(false);
    }
  });

  it("name contains only valid K8s characters when project and task are valid inputs", () => {
    // workerRunName sanitizes the task name but not the project name,
    // so with valid inputs the output should be fully K8s-valid.
    const name = workerRunName("my-project-123", "task-name!", 0, 0);
    expect(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)).toBe(true);
  });

  it("name starts with a letter or digit (not hyphen) for valid inputs", () => {
    const name = workerRunName("valid-project", "task-name!", 0, 0);
    expect(/^[a-z0-9]/.test(name)).toBe(true);
  });
});

describe("workerRunName — no collisions between retryCount and aiReworkCount namespaces", () => {
  it("retryCount=1,aiReworkCount=0 never collides with retryCount=0,aiReworkCount=N for any N", () => {
    const base = workerRunName("test-project", "build-abc", 1, 0);
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      names.push(workerRunName("test-project", "build-abc", 0, i));
    }
    expect(names).not.toContain(base);
  });

  it("retryCount=0,aiReworkCount=1 never collides with retryCount=2,aiReworkCount=0", () => {
    const a = workerRunName("test-project", "build-abc", 0, 1);
    const b = workerRunName("test-project", "build-abc", 2, 0);
    expect(a).not.toBe(b);
  });

  it("all combinations of retryCount [0..5] x aiReworkCount [0..5] produce unique names", () => {
    const names = new Set<string>();
    for (let rc = 0; rc <= 5; rc++) {
      for (let ar = 0; ar <= 5; ar++) {
        const name = workerRunName("test-project", "build-abc", rc, ar);
        expect(names.has(name)).toBe(false);
        names.add(name);
      }
    }
    expect(names.size).toBe(36); // all unique
  });

  it("different projects with same counters produce different names", () => {
    const a = workerRunName("proj-a", "task-x", 0, 5);
    const b = workerRunName("proj-b", "task-x", 0, 5);
    expect(a).not.toBe(b);
  });

  it("same project+task with different counters always differ from each other", () => {
    // Generate all pairs and verify every pair is distinct.
    const names: string[] = [];
    for (let rc = 0; rc <= 3; rc++) {
      for (let ar = 0; ar <= 3; ar++) {
        names.push(workerRunName("test-project", "task-x", rc, ar));
      }
    }
    const unique = new Set(names);
    expect(unique.size).toBe(names.length); // no duplicates
  });
});

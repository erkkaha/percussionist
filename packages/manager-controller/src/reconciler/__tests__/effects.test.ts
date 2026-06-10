import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as kube from "@percussionist/kube";
import * as workerBuilder from "../../worker-builder.js";
import * as facilitator from "../../facilitator.js";
import * as worktreeCleanup from "../../worktree-cleanup.js";
import * as sessionSummarizer from "../../session-summarizer.js";
import { executeEffects, type ReconcileEffect } from "../effects.js";
import { makeTask, makeProject, makeRun } from "./fixtures.js";
import { resolveFlow } from "../flow.js";
import type { Task, Run } from "@percussionist/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-05-29T00:00:00.000Z";
const namespace = "percussionist";

const testTask = makeTask("test-task", "test-project", { phase: "pending" });
const testProject = makeProject("test-project");
const flow = resolveFlow(testProject);

/** Shorthand to invoke executeEffects with default wiring. */
function call(
  task: Task = testTask,
  toPhase?: string,
  effects: ReconcileEffect[] = [],
  statusPatch?: Record<string, unknown>,
  project: Record<string, unknown> | null = {
    metadata: { name: testProject.metadata.name, uid: testProject.metadata.uid },
    spec: { ...testProject.spec },
  },
) {
  return executeEffects(
    task,
    toPhase as any,
    effects,
    statusPatch,
    namespace,
    project as any,
    flow,
    [task],
  );
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let getTaskSpy: ReturnType<typeof spyOn>;
let patchTaskStatusSpy: ReturnType<typeof spyOn>;
let patchTaskSpy: ReturnType<typeof spyOn>;
let patchProjectSpy: ReturnType<typeof spyOn>;
let createRunSpy: ReturnType<typeof spyOn>;
let deleteRunSpy: ReturnType<typeof spyOn>;
let createTaskSpy: ReturnType<typeof spyOn>;
let getRunSpy: ReturnType<typeof spyOn>;
let buildWorkerRunSpy: ReturnType<typeof spyOn>;
let buildMergeRunSpy: ReturnType<typeof spyOn>;
let buildReviewRunSpy: ReturnType<typeof spyOn>;
let buildBuildTaskGeneratorRunSpy: ReturnType<typeof spyOn>;
let spawnWorktreeCleanupPodSpy: ReturnType<typeof spyOn>;
let summarizeSessionSpy: ReturnType<typeof spyOn>;

const mockRun = makeRun("mock-run") as Run;

beforeEach(() => {
  // kube helpers
  getTaskSpy = spyOn(kube, "getTask").mockResolvedValue(testTask);
  patchTaskStatusSpy = spyOn(kube, "patchTaskStatus").mockResolvedValue(undefined as any);
  patchTaskSpy = spyOn(kube, "patchTask").mockResolvedValue(undefined as any);
  patchProjectSpy = spyOn(kube, "patchProject").mockResolvedValue(undefined as any);
  createRunSpy = spyOn(kube, "createRun").mockResolvedValue(undefined as any);
  deleteRunSpy = spyOn(kube, "deleteRun").mockResolvedValue(undefined as any);
  createTaskSpy = spyOn(kube, "createTask").mockResolvedValue(undefined as any);
  getRunSpy = spyOn(kube, "getRun").mockResolvedValue(mockRun);

  // worker-builder
  buildWorkerRunSpy = spyOn(workerBuilder, "buildWorkerRun").mockResolvedValue(mockRun);
  buildMergeRunSpy = spyOn(workerBuilder, "buildMergeRun").mockResolvedValue(mockRun);

  // facilitator (dynamically imported inside effects.ts)
  buildReviewRunSpy = spyOn(facilitator, "buildReviewRun").mockResolvedValue(mockRun);
  buildBuildTaskGeneratorRunSpy = spyOn(facilitator, "buildBuildTaskGeneratorRun").mockResolvedValue(mockRun);

  // worktree-cleanup
  spawnWorktreeCleanupPodSpy = spyOn(worktreeCleanup, "spawnWorktreeCleanupPod").mockResolvedValue(undefined as any);

  // session-summarizer
  summarizeSessionSpy = spyOn(sessionSummarizer, "summarizeSession").mockResolvedValue(undefined as any);
});

afterEach(() => {
  getTaskSpy.mockRestore();
  patchTaskStatusSpy.mockRestore();
  patchTaskSpy.mockRestore();
  patchProjectSpy.mockRestore();
  createRunSpy.mockRestore();
  deleteRunSpy.mockRestore();
  createTaskSpy.mockRestore();
  getRunSpy.mockRestore();
  buildWorkerRunSpy.mockRestore();
  buildMergeRunSpy.mockRestore();
  buildReviewRunSpy.mockRestore();
  buildBuildTaskGeneratorRunSpy.mockRestore();
  spawnWorktreeCleanupPodSpy.mockRestore();
  summarizeSessionSpy.mockRestore();
});

// ===========================================================================
// Tests
// ===========================================================================

describe("executeEffects — error guards", () => {
  it("returns error when re-fetched task is not found", async () => {
    getTaskSpy.mockRejectedValue(new Error("not found"));

    const result = await call();

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/not found during execution/);
  });

  it("returns error when phase changed since decision", async () => {
    const changedTask = makeTask("test-task", "test-project", { phase: "succeeded" });
    getTaskSpy.mockResolvedValue(changedTask);

    const result = await call(testTask, "scheduled");

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/phase changed from pending to succeeded/);
  });

  it("returns error for invalid transition", async () => {
    const result = await call(testTask, "done");

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/Invalid transition/);
  });

  it("returns error when an effect throws", async () => {
    const effects: ReconcileEffect[] = [
      { type: "DeleteRun", name: "run-a", reason: "cleanup" },
    ];
    const kubeErr = new Error("API error");
    (kubeErr as any).statusCode = 500;
    deleteRunSpy.mockRejectedValue(kubeErr);

    const result = await call(testTask, undefined, effects);

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/Effect DeleteRun failed/);
    // Effect didn't complete so push() never ran
    expect(result.effectsApplied).toEqual([]);
    // Final status patch should NOT have been called
    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
  });
});

describe("executeEffects — happy path with no effects", () => {
  it("applies toPhase only", async () => {
    const result = await call(testTask, "scheduled", []);

    expect(result.applied).toBe(true);
    expect(result.transition).toEqual({ from: "pending", to: "scheduled" });
    expect(patchTaskStatusSpy).toHaveBeenCalledTimes(1);
    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      "test-task",
      { phase: "scheduled" },
      namespace,
    );
  });

  it("applies statusPatch only", async () => {
    const result = await call(testTask, undefined, [], { worker: { runName: "r1" } });

    expect(result.applied).toBe(true);
    expect(result.transition).toEqual({ from: "pending", to: undefined });
    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      "test-task",
      { worker: { runName: "r1" }, phase: "pending" },
      namespace,
    );
  });

  it("applies toPhase + statusPatch merged", async () => {
    const result = await call(
      testTask,
      "scheduled",
      [],
      { worker: { runName: "r1", retryCount: 0 } },
    );

    expect(result.applied).toBe(true);
    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      "test-task",
      { worker: { runName: "r1", retryCount: 0 }, phase: "scheduled" },
      namespace,
    );
  });

  it("applies nothing when toPhase and statusPatch are both absent", async () => {
    const result = await call(testTask, undefined, [], undefined);

    expect(result.applied).toBe(true);
    // No patch should be applied since there's neither a phase change nor a statusPatch
    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-effect execution
// ---------------------------------------------------------------------------

describe("executeEffects — ScheduleRun", () => {
  const effect: ReconcileEffect = { type: "ScheduleRun", runName: "run-1", retryCount: 0 };
  const projectWithSource = {
    metadata: { name: "test-project", uid: "uid-test-project" },
    spec: { ...testProject.spec, source: { git: { url: "https://example.com/repo.git" } } },
  };

  it("creates a worker run via buildWorkerRun + createRun", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(result.effectsApplied).toEqual(["ScheduleRun"]);
    expect(buildWorkerRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ name: "test-project" }) }),
      testTask,
      "run-1",
      0,
      undefined,
      [testTask],
    );
    expect(createRunSpy).toHaveBeenCalled();
  });

  it("tolerates AlreadyExists on createRun", async () => {
    const existsErr = new Error("already exists");
    createRunSpy.mockRejectedValue(existsErr);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(result.effectsApplied).toEqual(["ScheduleRun"]);
  });

  it("propagates non-409 createRun errors", async () => {
    const apiErr = new Error("API error");
    createRunSpy.mockRejectedValue(apiErr);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/ScheduleRun failed/);
  });

  it("errors when project is null", async () => {
    const result = await call(testTask, undefined, [effect], undefined, null);

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/Project metadata required/);
  });
});

describe("executeEffects — ScheduleReviewRun", () => {
  const effect: ReconcileEffect = { type: "ScheduleReviewRun", reviewRunName: "review-1", succeededRunName: "worker-1", reviewAgent: "reviewer" };

  it("creates a review run via buildReviewRun + createRun", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(result.effectsApplied).toEqual(["ScheduleReviewRun"]);
    expect(getRunSpy).toHaveBeenCalledWith("worker-1", namespace);
    expect(buildReviewRunSpy).toHaveBeenCalled();
    expect(createRunSpy).toHaveBeenCalled();
  });

  it("tolerates AlreadyExists on createRun", async () => {
    createRunSpy.mockRejectedValue(new Error("already exists"));

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
  });
});

describe("executeEffects — ScheduleBuildGenRun", () => {
  const effect: ReconcileEffect = { type: "ScheduleBuildGenRun", buildgenRunName: "buildgen-1", succeededRunName: "worker-1" };

  it("creates a buildgen run via buildBuildTaskGeneratorRun + createRun", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(result.effectsApplied).toEqual(["ScheduleBuildGenRun"]);
    expect(buildBuildTaskGeneratorRunSpy).toHaveBeenCalled();
    expect(createRunSpy).toHaveBeenCalled();
  });

  it("re-creates when existing run is Failed", async () => {
    createRunSpy.mockRejectedValueOnce(new Error("already exists"));
    const failedRun = makeRun("buildgen-1", { phase: "Failed" });
    getRunSpy.mockResolvedValue(failedRun);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(deleteRunSpy).toHaveBeenCalledWith("buildgen-1", namespace);
    // createRun called once (fails with AlreadyExists), then re-created
    expect(createRunSpy).toHaveBeenCalledTimes(2);
  });

  it("re-creates when existing run is Cancelled", async () => {
    createRunSpy.mockRejectedValueOnce(new Error("already exists"));
    const cancelledRun = makeRun("buildgen-1", { phase: "Cancelled" });
    getRunSpy.mockResolvedValue(cancelledRun);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(deleteRunSpy).toHaveBeenCalled();
    expect(createRunSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-create when existing run is Succeeded", async () => {
    createRunSpy.mockRejectedValueOnce(new Error("already exists"));
    const succeededRun = makeRun("buildgen-1", { phase: "Succeeded" });
    getRunSpy.mockResolvedValue(succeededRun);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    // Only the original createRun should have been attempted
    expect(createRunSpy).toHaveBeenCalledTimes(1);
    expect(deleteRunSpy).not.toHaveBeenCalled();
  });
});

describe("executeEffects — ScheduleMergeRun", () => {
  const effect: ReconcileEffect = { type: "ScheduleMergeRun", mergeRunName: "merge-1" };

  it("creates a merge run via buildMergeRun + createRun", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(result.effectsApplied).toEqual(["ScheduleMergeRun"]);
    expect(buildMergeRunSpy).toHaveBeenCalled();
    expect(createRunSpy).toHaveBeenCalled();
  });

  it("tolerates AlreadyExists on createRun", async () => {
    createRunSpy.mockRejectedValue(new Error("already exists"));

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
  });
});

describe("executeEffects — CreateRun", () => {
  const effect: ReconcileEffect = { type: "CreateRun", run: makeRun("direct-run") as Run };

  it("calls createRun with the embedded run", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(createRunSpy).toHaveBeenCalledWith(effect.run, namespace);
  });

  it("tolerates AlreadyExists", async () => {
    createRunSpy.mockRejectedValue(new Error("already exists"));

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
  });
});

describe("executeEffects — DeleteRun", () => {
  const effect: ReconcileEffect = { type: "DeleteRun", name: "run-to-delete", reason: "cleanup" };

  it("calls deleteRun", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(deleteRunSpy).toHaveBeenCalledWith("run-to-delete", namespace);
  });

  it("tolerates NotFound (404)", async () => {
    const notFound = new Error("not found");
    (notFound as any).statusCode = 404;
    (notFound as any).response = { statusCode: 404 };
    deleteRunSpy.mockRejectedValue(notFound);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
  });

  it("propagates non-404 errors", async () => {
    const apiErr = new Error("API error");
    (apiErr as any).statusCode = 500;
    deleteRunSpy.mockRejectedValue(apiErr);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/DeleteRun failed/);
  });
});

describe("executeEffects — ClearTaskAnnotations", () => {
  it("clears task-scoped and project-scoped keys", async () => {
    const effect: ReconcileEffect = {
      type: "ClearTaskAnnotations",
      keys: ["percussionist.dev/action-answer", "some-project-key"],
    };

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    // task-scoped: percussionist.dev/action-*
    expect(patchTaskSpy).toHaveBeenCalledWith(
      "test-task",
      {
        metadata: {
          name: "test-task",
          annotations: { "percussionist.dev/action-answer": null },
        },
      },
      namespace,
    );
    // project-scoped: the rest
    expect(patchProjectSpy).toHaveBeenCalledWith(
      "test-project",
      {
        metadata: {
          name: "test-project",
          annotations: { "some-project-key": null },
        },
      },
      namespace,
    );
  });

  it("only clears task keys when none are action-prefixed", async () => {
    const effect: ReconcileEffect = {
      type: "ClearTaskAnnotations",
      keys: ["project-key-1", "project-key-2"],
    };

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(patchTaskSpy).not.toHaveBeenCalled();
    expect(patchProjectSpy).toHaveBeenCalled();
  });

  it("only clears project keys when all are action-prefixed", async () => {
    const effect: ReconcileEffect = {
      type: "ClearTaskAnnotations",
      keys: ["percussionist.dev/action-answer"],
    };

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(patchTaskSpy).toHaveBeenCalled();
    expect(patchProjectSpy).not.toHaveBeenCalled();
  });

  it("tolerates patch failures with a warning", async () => {
    patchTaskSpy.mockRejectedValue(new Error("patch failed"));

    const effect: ReconcileEffect = {
      type: "ClearTaskAnnotations",
      keys: ["percussionist.dev/action-answer"],
    };

    const result = await call(testTask, undefined, [effect]);

    // Fails silently (warn in console) — effect is considered applied
    expect(result.applied).toBe(true);
    expect(result.effectsApplied).toEqual(["ClearTaskAnnotations"]);
  });
});

describe("executeEffects — ClearProjectAnnotations", () => {
  it("clears given keys on the project", async () => {
    const effect: ReconcileEffect = { type: "ClearProjectAnnotations", keys: ["key-a", "key-b"] };

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(patchProjectSpy).toHaveBeenCalledWith(
      "test-project",
      {
        metadata: {
          name: "test-project",
          annotations: { "key-a": null, "key-b": null },
        },
      },
      namespace,
    );
  });

  it("does nothing when project has no name", async () => {
    const effect: ReconcileEffect = { type: "ClearProjectAnnotations", keys: ["key-a"] };

    const result = await call(testTask, undefined, [effect], undefined, {
      metadata: {},
      spec: {},
    });

    expect(result.applied).toBe(true);
    expect(patchProjectSpy).not.toHaveBeenCalled();
  });
});

describe("executeEffects — CleanupWorktree", () => {
  const effect: ReconcileEffect = { type: "CleanupWorktree", runName: "run-1" };

  it("spawns a cleanup pod when project is available", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(spawnWorktreeCleanupPodSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runName: "run-1", namespace: "percussionist" }),
    );
  });

  it("skips when project is null", async () => {
    const result = await call(testTask, undefined, [effect], undefined, null);

    expect(result.applied).toBe(true);
    expect(spawnWorktreeCleanupPodSpy).not.toHaveBeenCalled();
  });
});

describe("executeEffects — SummarizeSession", () => {
  const effect: ReconcileEffect = {
    type: "SummarizeSession",
    project: "test-project",
    runName: "run-1",
    sessionID: "session-abc",
  };

  it("fires summarization asynchronously and does not block", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    // Allow the microtask queue to flush the fire-and-forget promise
    await new Promise((r) => setTimeout(r, 0));
    expect(summarizeSessionSpy).toHaveBeenCalledWith("test-project", "run-1", "session-abc", namespace);
  });
});

describe("executeEffects — CreateTask", () => {
  const childTask = makeTask("child-task", "test-project");
  const effect: ReconcileEffect = { type: "CreateTask", task: childTask as Task };

  it("calls createTask with the embedded task", async () => {
    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
    expect(createTaskSpy).toHaveBeenCalledWith(childTask, namespace);
  });

  it("tolerates AlreadyExists (409)", async () => {
    const conflictErr = new Error("Conflict");
    (conflictErr as any).statusCode = 409;
    createTaskSpy.mockRejectedValue(conflictErr);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(true);
  });

  it("propagates non-409 errors", async () => {
    const apiErr = new Error("API error");
    (apiErr as any).statusCode = 500;
    createTaskSpy.mockRejectedValue(apiErr);

    const result = await call(testTask, undefined, [effect]);

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/CreateTask failed/);
  });
});

// ---------------------------------------------------------------------------
// Multiple effects
// ---------------------------------------------------------------------------

describe("executeEffects — multiple effects", () => {
  it("executes all effects in sequence on success", async () => {
    const effects: ReconcileEffect[] = [
      { type: "DeleteRun", name: "r1", reason: "cleanup" },
      { type: "DeleteRun", name: "r2", reason: "cleanup" },
    ];

    const result = await call(testTask, undefined, effects);

    expect(result.applied).toBe(true);
    expect(result.effectsApplied).toEqual(["DeleteRun", "DeleteRun"]);
    expect(deleteRunSpy).toHaveBeenCalledTimes(2);
    expect(deleteRunSpy).toHaveBeenNthCalledWith(1, "r1", namespace);
    expect(deleteRunSpy).toHaveBeenNthCalledWith(2, "r2", namespace);
  });

  it("stops at the first failing effect", async () => {
    const effects: ReconcileEffect[] = [
      { type: "DeleteRun", name: "r1", reason: "cleanup" },
      { type: "DeleteRun", name: "r2", reason: "cleanup" },
    ];
    const apiErr = new Error("API error");
    (apiErr as any).statusCode = 500;
    deleteRunSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(apiErr);

    const result = await call(testTask, undefined, effects);

    expect(result.applied).toBe(false);
    expect(result.effectsApplied).toEqual(["DeleteRun"]);
    expect(deleteRunSpy).toHaveBeenCalledTimes(2); // first ok, second failed
    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Status patch with effects
// ---------------------------------------------------------------------------

describe("executeEffects — status patch + effects", () => {
  it("applies status patch after successful effects", async () => {
    const effects: ReconcileEffect[] = [
      { type: "DeleteRun", name: "r1", reason: "cleanup" },
    ];

    const result = await call(testTask, "scheduled", effects, { worker: { runName: "r1" } });

    expect(result.applied).toBe(true);
    expect(result.effectsApplied).toEqual(["DeleteRun"]);
    expect(deleteRunSpy).toHaveBeenCalled();
    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      "test-task",
      { worker: { runName: "r1" }, phase: "scheduled" },
      namespace,
    );
  });
});

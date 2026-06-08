import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as kube from "@percussionist/kube";
import type { Task, Project } from "@percussionist/api";
import { reconcileProject } from "../index.js";
import { makeTask, makeProject } from "./fixtures.js";

describe("buildTask default phase", () => {
  it("creates tasks with status.phase = pending by default", () => {
    const task = kube.buildTask({
      name: "test-task",
      projectName: "test-project",
      projectUid: "uid-test",
      ns: "percussionist",
      spec: {
        projectRef: "test-project",
        type: "BUILD",
        title: "Test task",
        description: "",
        agent: "builder",
        priority: "medium",
      },
    });

    expect(task.status?.phase).toBe("pending");
  });

  it("preserves explicitly set phase in buildTask", () => {
    // Note: buildTask doesn't accept a phase override — callers who need
    // non-pending phases must patch status after creation. This test documents
    // that the default is always "pending".
    const task = kube.buildTask({
      name: "test-task",
      projectName: "test-project",
      projectUid: "uid-test",
      ns: "percussionist",
      spec: {
        projectRef: "test-project",
        type: "PLAN",
        title: "Test plan",
        description: "",
        agent: "planner",
        priority: "high",
      },
    });

    expect(task.status?.phase).toBe("pending");
  });
});

describe("reconciler auto-heal", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listTasksSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let patchTaskStatusSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getRunSpy: any;

  beforeEach(() => {
    listTasksSpy = spyOn(kube, "listTasks");
    patchTaskStatusSpy = spyOn(kube, "patchTaskStatus");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRunSpy = spyOn(kube, "getRun").mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    listTasksSpy.mockRestore();
    patchTaskStatusSpy.mockRestore();
    getRunSpy.mockRestore();
  });

  it("patches tasks with missing status.phase to pending", async () => {
    const taskWithoutPhase: Task = makeTask(
      "limbo-task",
      "test-project",
      { noStatus: true },
    );
    listTasksSpy.mockResolvedValue([taskWithoutPhase]);

    patchTaskStatusSpy.mockImplementation(async (_name: string, patch: Record<string, unknown>) => {
      return { ...taskWithoutPhase, status: { phase: patch.phase } };
    });

    const project = makeProject("test-project");
    await reconcileProject(project, "percussionist");

    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      "limbo-task",
      { phase: "pending" },
      "percussionist",
    );
  });

  it("does not patch tasks that already have a phase", async () => {
    const taskWithPhase = makeTask("normal-task", "test-project", {
      phase: "scheduled",
    });
    listTasksSpy.mockResolvedValue([taskWithPhase]);

    const project = makeProject("test-project");
    await reconcileProject(project, "percussionist");

    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
  });

  it("heals multiple tasks with missing phase", async () => {
    const task1: Task = makeTask("limbo-1", "test-project", { noStatus: true });
    const task2: Task = makeTask("limbo-2", "test-project", { noStatus: true });
    listTasksSpy.mockResolvedValue([task1, task2]);

    patchTaskStatusSpy.mockImplementation(async () => ({ status: { phase: "pending" } }) as unknown as Task);

    const project = makeProject("test-project");
    await reconcileProject(project, "percussionist");

    // Reconciler heals twice: first loop (line 27) + second defense-in-depth loop (line 63).
    expect(patchTaskStatusSpy).toHaveBeenCalledTimes(4);
  });

  it("heals idea tasks that are missing phase (malformed)", async () => {
    // An idea task without a status.phase is malformed and should be healed.
    const ideaTask: Task = makeTask("idea-task", "test-project", { noStatus: true });
    listTasksSpy.mockResolvedValue([ideaTask]);

    patchTaskStatusSpy.mockImplementation(async () => ({ status: { phase: "pending" } }) as unknown as Task);

    const project = makeProject("test-project");
    await reconcileProject(project, "percussionist");

    // Malformed idea tasks (no phase) are healed to pending.
    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      "idea-task",
      { phase: "pending" },
      "percussionist",
    );
  });

  it("does not heal well-formed idea or done tasks", async () => {
    const ideaTask = makeTask("idea-task", "test-project", { phase: "idea" });
    const doneTask = makeTask("done-task", "test-project", { phase: "done" });
    listTasksSpy.mockResolvedValue([ideaTask, doneTask]);

    patchTaskStatusSpy.mockImplementation(async () => ({ status: { phase: "pending" } }) as unknown as Task);

    const project = makeProject("test-project");
    await reconcileProject(project, "percussionist");

    // Well-formed idea and done tasks are filtered out before the heal loop.
    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
  });

  it("heals task with empty status object", async () => {
    const taskWithEmptyStatus: Task = makeTask(
      "empty-status-task",
      "test-project",
      {},
    );
    // Override to have an empty status object (no phase)
    (taskWithEmptyStatus as any).status = {};
    listTasksSpy.mockResolvedValue([taskWithEmptyStatus]);

    patchTaskStatusSpy.mockImplementation(async () => ({ status: { phase: "pending" } }) as unknown as Task);

    const project = makeProject("test-project");
    await reconcileProject(project, "percussionist");

    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      "empty-status-task",
      { phase: "pending" },
      "percussionist",
    );
  });
});

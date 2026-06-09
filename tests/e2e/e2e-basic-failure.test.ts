/**
 * e2e-basic-failure: worker pod fails (invalid git URL) → run reaches Failed → task reaches failed.
 *
 * Scenario:
 *   1. Shared cluster setup (CRDs, operator, manager, namespace, RBAC, LLM secret).
 *   2. Apply ClusterAgent: e2e-failing-worker.
 *   3. Apply Project with an intentionally invalid git URL so the
 *      git-clone init container fails deterministically.
 *   4. Apply Task CR (type=BUILD, agent=e2e-failing-worker).
 *   5. Assert: worker Run reaches phase=Failed.
 *   6. Assert: Task CR phase reaches "failed".
 */

import { describe, beforeAll, afterAll, it, expect } from "bun:test";
import {
  setupCluster,
  applyClusterAgents,
  applyProject,
  applyTask,
  teardown,
} from "./helpers/setup.ts";
import {
  kubectlGetNames,
  kubectlGetField,
} from "./helpers/kubectl.ts";
import { waitFor } from "./helpers/wait.ts";

const NS = "percussionist-e2e";
const PROJECT = "e2e-basic-failure-test";
const TASK_NAME = "t1";
const TASK_LABEL = "percussionist.dev/task-id";
const LLM_SECRET = process.env["LLM_SECRET"] ?? "llm-keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the first worker run for a task (no .spec.facilitation.targetRunName). */
async function findWorkerRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames("runs", ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const target = await kubectlGetField("runs", name, ns, "{.spec.facilitation.targetRunName}");
    if (!target) return name;
  }
  return null;
}

/** Poll until a run reaches the expected phase. Returns the phase string on match. */
async function pollPhase(
  runName: string,
  ns: string,
  expected: string,
): Promise<string | null> {
  const phase = await kubectlGetField("runs", runName, ns, "{.status.phase}");
  return phase === expected ? phase : null;
}

/** Poll until the Task CR phase matches expected. */
async function pollTaskPhase(
  taskName: string,
  ns: string,
  expected: string,
): Promise<true | null> {
  const phase = await kubectlGetField("tasks", taskName, ns, "{.status.phase}");
  return phase === expected ? true : null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("basic-failure", () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents([
      "clusteragent-failing-worker.yaml",
    ]);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: "E2E Facilitator Test",
      llmSecret: LLM_SECRET,
      phase: "Active",
      maxParallel: 1,
      agents: [{ name: "e2e-failing-worker" }],
      timeoutSeconds: 120,
      sourceYaml: `\
  source:
    git:
      # Intentionally invalid URL — git-clone init container fails deterministically.
      url: https://git.invalid/e2e-nonexistent-repo.git`,
    });

    console.log(`==> Step 9: Apply Task ${TASK_NAME}`);
    await applyTask({
      name: TASK_NAME,
      ns: NS,
      projectRef: PROJECT,
      type: "BUILD",
      title: "Fail intentionally",
      agent: "e2e-failing-worker",
      description: "This task is intentionally designed to fail so that the failure path is exercised.",
    });
  });

  afterAll(async () => {
    await teardown(NS);
  });

  let workerRun: string;

  it(
    "worker run is spawned",
    async () => {
      workerRun = await waitFor(
        `worker run spawned (taskId=${TASK_NAME})`,
        120,
        5,
        () => findWorkerRun(NS, TASK_NAME),
      );
      expect(workerRun).toBeTruthy();
      console.log(`    Worker run spawned: ${workerRun}`);
    },
    125_000,
  );

  it(
    "worker run reaches Failed",
    async () => {
      // git-clone init container fails on invalid URL; allow up to 300s.
      await waitFor(
        `worker run ${workerRun} reaches Failed`,
        300,
        10,
        () => pollPhase(workerRun, NS, "Failed"),
      );
      const phase = await kubectlGetField("runs", workerRun, NS, "{.status.phase}");
      expect(phase).toBe("Failed");

      // Strict: status message must be present and non-empty for a Failed run.
      const msg = await kubectlGetField("runs", workerRun, NS, "{.status.message}");
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    },
    305_000,
  );

  it(
    "task phase reaches failed",
    async () => {
      // Manager reconciles on a ~30s periodic resync; allow up to 180s.
      await waitFor(
        `task ${TASK_NAME} phase=failed`,
        180,
        10,
        () => pollTaskPhase(TASK_NAME, NS, "failed"),
      );
      const taskPhase = await kubectlGetField("tasks", TASK_NAME, NS, "{.status.phase}");
      expect(taskPhase).toBe("failed");
    },
    185_000,
  );
});

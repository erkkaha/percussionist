/**
 * e2e-advances: agent calls complete_run → reviewer approves → task moves to done.
 *
 * Scenario:
 *   1. Shared cluster setup.
 *   2. Apply ClusterAgents: e2e-complete-worker, reviewer-approve.
 *   3. Apply Project (no source — worker calls complete_run immediately).
 *   4. Assert: worker run reaches Succeeded via complete_run MCP tool.
 *   5. Assert: manager spawns a success-review facilitation run.
 *   6. Assert: review run completes with Succeeded (deterministic fixture).
 *   7. Assert: task appears in board columns["done"].
 */

import { describe, beforeAll, afterAll, it, expect } from "bun:test";
import {
  setupCluster,
  applyClusterAgents,
  applyProject,
  teardown,
  OPERATOR_NS,
} from "./helpers/setup.ts";
import {
  kubectlGetNames,
  kubectlGetField,
  boardJson,
} from "./helpers/kubectl.ts";
import { waitFor } from "./helpers/wait.ts";

const NS = "percussionist-e2e-advances";
const PROJECT = "e2e-advances-test";
const TASK_ID = "t1";
const TASK_LABEL = "percussionist.dev/task-id";
const LLM_SECRET = process.env["LLM_SECRET"] ?? "llm-keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the initial worker run (no .spec.facilitation.targetRunName). */
async function findWorkerRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames("runs", ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const target = await kubectlGetField("runs", name, ns, "{.spec.facilitation.targetRunName}");
    if (!target) return name;
  }
  return null;
}

/**
 * Find a facilitation run for the task that is not the worker run itself.
 * The review run has .spec.facilitation.targetRunName set.
 */
async function findReviewRun(
  ns: string,
  taskId: string,
  workerRun: string,
): Promise<string | null> {
  const names = await kubectlGetNames("runs", ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    if (name === workerRun) continue;
    const target = await kubectlGetField("runs", name, ns, "{.spec.facilitation.targetRunName}");
    if (target) return name;
  }
  return null;
}

/** Poll until a run is in a terminal phase (Succeeded or Failed). */
async function pollTerminal(runName: string, ns: string): Promise<string | null> {
  const phase = await kubectlGetField("runs", runName, ns, "{.status.phase}");
  return phase === "Succeeded" || phase === "Failed" ? phase : null;
}

/** Poll until task is in board columns["done"]. */
async function pollTaskInDone(
  project: string,
  taskId: string,
  operatorNs: string,
): Promise<true | null> {
  const board = await boardJson(project, operatorNs);
  const columns = board["columns"] as Record<string, string[]> | undefined;
  const done = columns?.["done"] ?? [];
  return done.includes(taskId) ? true : null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("advances", () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents([
      "clusteragent-complete-worker.yaml",
      "clusteragent-reviewer-approve.yaml",
    ]);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: "E2E Advances Test",
      llmSecret: LLM_SECRET,
      boardYaml: `\
  board:
    phase: Active
    maxParallel: 1
    agents:
      - name: e2e-complete-worker
      - name: reviewer-approve
    tasks:
      - id: t1
        title: "Write a greeting"
        type: BUILD
        agent: e2e-complete-worker
        description: >
          Write a short greeting message to the user.`,
    });
  });

  afterAll(async () => {
    await teardown(NS);
  });

  let workerRun: string;
  let reviewRun: string;

  it(
    "worker run is spawned",
    async () => {
      workerRun = await waitFor(
        `worker run spawned (taskId=${TASK_ID})`,
        120,
        3,
        () => findWorkerRun(NS, TASK_ID),
      );
      expect(workerRun).toBeTruthy();
      console.log(`    Worker run spawned: ${workerRun}`);
    },
    125_000,
  );

  it(
    "worker run reaches Succeeded via complete_run",
    async () => {
      await waitFor(
        `worker run ${workerRun} reaches Succeeded`,
        180,
        3,
        async () => {
          const phase = await kubectlGetField("runs", workerRun, NS, "{.status.phase}");
          if (phase === "Failed") throw new Error(`Worker run reached Failed unexpectedly`);
          return phase === "Succeeded" ? phase : null;
        },
      );
      // Strict: status message must confirm completion via complete_run MCP tool.
      const msg = await kubectlGetField("runs", workerRun, NS, "{.status.message}");
      expect(msg).toContain("agent signalled completion");
    },
    185_000,
  );

  it(
    "success-review run is spawned",
    async () => {
      reviewRun = await waitFor(
        "success-review run spawned",
        180,
        3,
        () => findReviewRun(NS, TASK_ID, workerRun),
      );
      expect(reviewRun).toBeTruthy();
      console.log(`    Success-review run spawned: ${reviewRun}`);

      // Strict: review run must reference the exact worker run.
      const target = await kubectlGetField(
        "runs",
        reviewRun,
        NS,
        "{.spec.facilitation.targetRunName}",
      );
      expect(target).toBe(workerRun);

      // Strict: review run must reference the correct task ID.
      const targetTaskId = await kubectlGetField(
        "runs",
        reviewRun,
        NS,
        "{.spec.facilitation.targetTaskId}",
      );
      expect(targetTaskId).toBe(TASK_ID);

      // Strict: successReview flag must be true for a success-review run.
      const successReview = await kubectlGetField(
        "runs",
        reviewRun,
        NS,
        "{.spec.facilitation.successReview}",
      );
      expect(successReview).toBe("true");

      // Assert worker run status fields are populated before review starts.
      const workerPhase = await kubectlGetField("runs", workerRun, NS, "{.status.phase}");
      expect(workerPhase).toBe("Succeeded");
    },
    185_000,
  );

  it(
    "review run completes",
    async () => {
      const phase = await waitFor(
        `review run ${reviewRun} completes`,
        600,
        5,
        () => pollTerminal(reviewRun, NS),
      );
      // Strict: deterministic reviewer fixture must produce Succeeded.
      expect(phase).toBe("Succeeded");
    },
    605_000,
  );

  it(
    "task moves to board done",
    async () => {
      await waitFor(
        `task ${TASK_ID} in board columns[done]`,
        180,
        3,
        () => pollTaskInDone(PROJECT, TASK_ID, OPERATOR_NS),
      );
      const board = await boardJson(PROJECT, OPERATOR_NS);
      const done = (board["columns"] as Record<string, string[]>)?.["done"] ?? [];
      expect(done).toContain(TASK_ID);
      console.log("    Board status:", JSON.stringify(board, null, 2));
    },
    185_000,
  );
});

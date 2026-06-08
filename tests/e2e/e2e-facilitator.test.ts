/**
 * e2e-facilitator: board task → worker fails → facilitator run is spawned.
 *
 * Scenario:
 *   1. Shared cluster setup (CRDs, operator, manager, namespace, RBAC, LLM secret).
 *   2. Apply ClusterAgents: e2e-failing-worker, failure-analyst.
 *   3. Apply Project with an intentionally invalid git URL so the
 *      git-clone init container fails deterministically.
 *   4. Assert: worker Run reaches phase=Failed.
 *   5. Assert: manager spawns a facilitator run (has .spec.facilitation.targetRunName).
 */

import { describe, beforeAll, afterAll, it, expect } from "bun:test";
import {
  setupCluster,
  applyClusterAgents,
  applyProject,
  teardown,
  MANIFESTS,
  OPERATOR_NS,
} from "./helpers/setup.ts";
import {
  kubectlGetNames,
  kubectlGetField,
  boardJson,
} from "./helpers/kubectl.ts";
import { waitFor } from "./helpers/wait.ts";

const NS = "percussionist-e2e";
const PROJECT = "e2e-facilitator-test";
const TASK_ID = "t1";
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

/** Find the first facilitation run for a task (has .spec.facilitation.targetRunName). */
async function findFacilitatorRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames("runs", ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const target = await kubectlGetField("runs", name, ns, "{.spec.facilitation.targetRunName}");
    if (target) return name;
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("facilitator", () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents([
      "clusteragent-failing-worker.yaml",
      "clusteragent-failure-analyst.yaml",
    ]);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: "E2E Facilitator Test",
      llmSecret: LLM_SECRET,
      sourceYaml: `\
  source:
    git:
      # Intentionally invalid URL — git-clone init container fails deterministically.
      url: https://git.invalid/e2e-nonexistent-repo.git`,
      boardYaml: `\
  board:
    phase: Active
    maxParallel: 1
    agents:
      - name: e2e-failing-worker
      - name: failure-analyst
    overrides:
      timeoutSeconds: 120
    tasks:
      - id: t1
        title: "Fail intentionally"
        type: BUILD
        agent: e2e-failing-worker
        description: >
          This task is intentionally designed to time out and fail so that the
          facilitator agent is triggered to investigate.`,
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
        `worker run spawned (taskId=${TASK_ID})`,
        120,
        5,
        () => findWorkerRun(NS, TASK_ID),
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
    "facilitator run is spawned",
    async () => {
      // Manager reconciles on a ~30s periodic resync; allow up to 180s.
      const facilitatorRun = await waitFor(
        `facilitator run spawned (taskId=${TASK_ID})`,
        180,
        10,
        () => findFacilitatorRun(NS, TASK_ID),
      );
      expect(facilitatorRun).toBeTruthy();
      console.log(`    Facilitator run spawned: ${facilitatorRun}`);

      // Strict: facilitation must link back to the exact worker run.
      const target = await kubectlGetField(
        "runs",
        facilitatorRun,
        NS,
        "{.spec.facilitation.targetRunName}",
      );
      expect(target).toBe(workerRun);

      // Strict: facilitation must reference the correct task ID.
      const targetTaskId = await kubectlGetField(
        "runs",
        facilitatorRun,
        NS,
        "{.spec.facilitation.targetTaskId}",
      );
      expect(targetTaskId).toBe(TASK_ID);

      // Strict: facilitation must include a non-empty failure reason.
      const failureReason = await kubectlGetField(
        "runs",
        facilitatorRun,
        NS,
        "{.spec.facilitation.failureReason}",
      );
      expect(failureReason.length).toBeGreaterThan(0);

      // Assert worker run status fields are populated.
      const workerPhase = await kubectlGetField("runs", workerRun, NS, "{.status.phase}");
      expect(workerPhase).toBe("Failed");
      const workerMessage = await kubectlGetField("runs", workerRun, NS, "{.status.message}");
      expect(typeof workerMessage).toBe("string");

      // Assert facilitator run has a phase set (not still Pending/Initializing).
      const facPhase = await kubectlGetField(
        "runs",
        facilitatorRun,
        NS,
        "{.status.phase}",
      );
      expect(facPhase).toBeTruthy();
      expect(["Running", "WaitingForInput"]).toContain(facPhase);

      const board = await boardJson(PROJECT, OPERATOR_NS);
      console.log("    Board status:", JSON.stringify(board, null, 2));
    },
    185_000,
  );
});

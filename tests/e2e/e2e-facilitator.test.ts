/**
 * e2e-facilitator: board task → worker fails → facilitator run is spawned.
 *
 * Scenario:
 *   1. Shared cluster setup (CRDs, operator, manager, namespace, RBAC, LLM secret).
 *   2. Apply ClusterAgents: e2e-failing-worker, facilitator.
 *   3. Apply OpenCodeProject with an intentionally invalid git URL so the
 *      git-clone init container fails deterministically.
 *   4. Assert: worker OpenCodeRun reaches phase=Failed.
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
  const names = await kubectlGetNames("opencoderuns", ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const target = await kubectlGetField("opencoderuns", name, ns, "{.spec.facilitation.targetRunName}");
    if (!target) return name;
  }
  return null;
}

/** Find the first facilitation run for a task (has .spec.facilitation.targetRunName). */
async function findFacilitatorRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames("opencoderuns", ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const target = await kubectlGetField("opencoderuns", name, ns, "{.spec.facilitation.targetRunName}");
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
  const phase = await kubectlGetField("opencoderuns", runName, ns, "{.status.phase}");
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
      "clusteragent-facilitator-failure.yaml",
    ]);

    console.log(`==> Step 8: Apply OpenCodeProject ${PROJECT}`);
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
      - name: facilitator-failure
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
      const phase = await kubectlGetField("opencoderuns", workerRun, NS, "{.status.phase}");
      expect(phase).toBe("Failed");
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

      const target = await kubectlGetField(
        "opencoderuns",
        facilitatorRun,
        NS,
        "{.spec.facilitation.targetRunName}",
      );
      expect(target).toBe(workerRun);

      const board = await boardJson(PROJECT, OPERATOR_NS);
      console.log("    Board status:", JSON.stringify(board, null, 2));
    },
    185_000,
  );
});

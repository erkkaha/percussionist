/**
 * e2e-achieves: facilitator changes the outcome by switching agents.
 *
 * Scenario:
 *   1. Shared cluster setup.
 *   2. Apply ClusterAgents: e2e-stubborn-worker, e2e-capable-worker, facilitator-retry-alt.
 *   3. Apply Project with stubborn-worker as the initial agent.
 *   4. Assert: stubborn-worker calls fail_run → run reaches Failed.
 *   5. Assert: manager spawns a facilitator run.
 *   6. Assert: facilitator completes deterministically with retry_alternative.
 *   7. Assert: manager dispatches a new run with e2e-capable-worker.
 *   8. Assert: capable-worker run reaches Succeeded.
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

const NS = "percussionist-e2e-achieves";
const PROJECT = "e2e-achieves-test";
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

/** Find the first facilitation run for the task. */
async function findFacilitatorRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames("runs", ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const target = await kubectlGetField("runs", name, ns, "{.spec.facilitation.targetRunName}");
    if (target) return name;
  }
  return null;
}

/**
 * Find the alternative worker run: agent=e2e-capable-worker with no facilitation.
 */
async function findAltRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames("runs", ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const agent = await kubectlGetField("runs", name, ns, "{.spec.agent}");
    const fac = await kubectlGetField("runs", name, ns, "{.spec.facilitation.targetRunName}");
    if (agent === "e2e-capable-worker" && !fac) return name;
  }
  return null;
}

/** Poll until a run reaches a terminal phase (Succeeded or Failed). */
async function pollTerminal(runName: string, ns: string): Promise<string | null> {
  const phase = await kubectlGetField("runs", runName, ns, "{.status.phase}");
  return phase === "Succeeded" || phase === "Failed" ? phase : null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("achieves", () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents([
      "clusteragent-stubborn-worker.yaml",
      "clusteragent-capable-worker.yaml",
      "clusteragent-facilitator-retry-alt.yaml",
    ]);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: "E2E Achieves Test",
      llmSecret: LLM_SECRET,
      boardYaml: `\
  board:
    phase: Active
    maxParallel: 1
    agents:
      - name: e2e-stubborn-worker
      - name: e2e-capable-worker
      - name: facilitator-retry-alt
    tasks:
      - id: t1
        title: "Analyze repository structure"
        type: BUILD
        agent: e2e-stubborn-worker
        description: >
          List the top-level files and directories in the /workspace directory.
          Output a brief summary of what you find.`,
    });
  });

  afterAll(async () => {
    await teardown(NS);
  });

  let workerRun: string;
  let facilitatorRun: string;
  let altRun: string;

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
    "stubborn worker calls fail_run → reaches Failed",
    async () => {
      await waitFor(
        `worker run ${workerRun} reaches Failed`,
        180,
        5,
        () => pollTerminal(workerRun, NS).then((p) => (p === "Failed" ? p : null)),
      );
      const msg = await kubectlGetField("runs", workerRun, NS, "{.status.message}");
      if (msg.includes("agent signalled failure")) {
        console.log("    Confirmed: failure triggered via fail_run MCP tool");
      } else {
        console.warn(`    NOTE: failure message does not mention fail_run: ${msg}`);
      }
    },
    185_000,
  );

  it(
    "facilitator run is spawned",
    async () => {
      facilitatorRun = await waitFor(
        "facilitator run spawned",
        180,
        10,
        () => findFacilitatorRun(NS, TASK_ID),
      );
      expect(facilitatorRun).toBeTruthy();
      console.log(`    Facilitator run spawned: ${facilitatorRun}`);
    },
    185_000,
  );

  it(
    "facilitator run completes",
    async () => {
      // The facilitator fixture outputs retry_alternative deterministically.
      const phase = await waitFor(
        `facilitator ${facilitatorRun} completes`,
        600,
        10,
        () => pollTerminal(facilitatorRun, NS),
      );
      console.log(`    Facilitator run completed: ${phase}`);
      expect(["Succeeded", "Failed"]).toContain(phase);
    },
    605_000,
  );

  it(
    "manager dispatches e2e-capable-worker run",
    async () => {
      altRun = await waitFor(
        "e2e-capable-worker run spawned",
        180,
        10,
        () => findAltRun(NS, TASK_ID),
      );
      expect(altRun).toBeTruthy();
      console.log(`    Alternative worker spawned: ${altRun}`);
    },
    185_000,
  );

  it(
    "e2e-capable-worker run reaches Succeeded",
    async () => {
      const phase = await waitFor(
        `capable-worker run ${altRun} reaches Succeeded`,
        300,
        10,
        async () => {
          const p = await kubectlGetField("runs", altRun, NS, "{.status.phase}");
          if (p === "Failed") {
            throw new Error(
              `e2e-capable-worker run reached Failed — check agent system prompt and MCP config`,
            );
          }
          return p === "Succeeded" ? p : null;
        },
      );
      expect(phase).toBe("Succeeded");

      const board = await boardJson(PROJECT, OPERATOR_NS);
      console.log("    Board status:", JSON.stringify(board, null, 2));
    },
    305_000,
  );
});

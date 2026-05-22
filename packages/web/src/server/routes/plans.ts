// routes/plans.ts — API endpoint for fetching plan artifacts.
//
// This endpoint proxies to the manager's MCP tool `read_plan` which reads
// .percussionist/plans/{plan-task-id}.md from a completed run's workspace.

import { Hono } from "hono";
import { NAMESPACE } from "../kube.js";

const router = new Hono();

const MANAGER_SERVICE = `http://percussionist-manager.${NAMESPACE}.svc.cluster.local`;
const MCP_URL = `${MANAGER_SERVICE}:4097/mcp`;

// GET /api/projects/:project/plans/:taskId
//
// Fetches the plan artifact for a given task. For BUILD tasks, this resolves
// the parent PLAN task automatically. The plan content is read from the task's
// most recent run workspace or ConfigMap snapshot.
router.get("/:project/plans/:taskId", async (c) => {
  const project = c.req.param("project");
  const taskId = c.req.param("taskId");

  if (!project || !taskId) {
    return c.json({ error: "Missing required parameters: project, taskId" }, 400);
  }

  // First, we need to find a run for this task to pass to read_plan.
  // The read_plan tool requires a runName, so we need to look up the task
  // and get its worker.runName.
  try {
    // Import kube helpers
    const { getTask } = await import("../kube.js");
    
    const task = await getTask(taskId);
    const runName = task.status?.worker?.runName;

    if (!runName) {
      return c.json(
        {
          error: `Task ${taskId} has no completed run. Plan artifacts are only available after the task has run at least once.`,
          taskId,
          project,
        },
        404,
      );
    }

    // Call the manager's MCP tool read_plan
    const mcpRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "read_plan",
        arguments: {
          runName,
          namespace: NAMESPACE,
        },
      },
    };

    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mcpRequest),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return c.json(
        { error: `Manager MCP service returned ${res.status}` },
        502,
      );
    }

    const mcpResponse = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result?: {
        content: Array<{ type: string; text: string }>;
      };
      error?: { code: number; message: string };
    };

    if (mcpResponse.error) {
      return c.json(
        { error: mcpResponse.error.message, taskId, project },
        500,
      );
    }

    // Extract the plan content from the MCP response
    const content = mcpResponse.result?.content?.[0]?.text;
    if (!content) {
      return c.json(
        {
          error: "Plan content not found. The task may not have created a plan artifact yet.",
          taskId,
          project,
        },
        404,
      );
    }

    return c.json({
      content,
      taskId,
      project,
    });
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg, taskId, project }, 500);
  }
});

export default router;

// routes/plans.ts — API endpoint for fetching plan artifacts.
//
// This endpoint proxies to the manager's MCP tool `read_plan` which reads
// .percussionist/plans/{plan-task-id}.md from a completed run's workspace.

import { Hono } from 'hono';
import { auth } from '../auth.js';
import { NAMESPACE } from '../kube.js';

const router = new Hono();

const MANAGER_SERVICE = `http://percussionist-manager.${NAMESPACE}.svc.cluster.local`;
const MCP_URL = `${MANAGER_SERVICE}:4097/mcp`;

// GET /api/projects/:project/plans/:taskId
//
// Fetches the plan artifact for a given task. For BUILD tasks, this resolves
// the parent PLAN task automatically. The plan content is read from the task's
// most recent run workspace or ConfigMap snapshot.
router.get('/:project/plans/:taskId', auth(), async (c) => {
  const project = c.req.param('project');
  const taskId = c.req.param('taskId');

  if (!project || !taskId) {
    return c.json({ error: 'Missing required parameters: project, taskId' }, 400);
  }

  // Call the manager's MCP tool read_plan.
  // The tool requires project and task parameters, and it will automatically
  // resolve the plan task ID (for BUILD tasks, it reads the parent PLAN).
  try {
    const mcpRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'read_plan',
        arguments: {
          project,
          task: taskId,
          namespace: NAMESPACE,
        },
      },
    };

    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mcpRequest),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return c.json({ error: `Manager MCP service returned ${res.status}` }, 502);
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
      return c.json({ error: mcpResponse.error.message, taskId, project }, 500);
    }

    // Extract the plan content from the MCP response.
    // The MCP server wraps all tool results as JSON.stringify(result), so
    // content[0].text is a JSON string like {"content":"## Plan...","exists":true,...}.
    // Parse it and extract the inner .content field.
    const rawText = mcpResponse.result?.content?.[0]?.text;
    let content: string | null = null;
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        content = typeof parsed.content === 'string' ? parsed.content : null;
      } catch {
        // Not JSON — treat as raw markdown (fallback)
        content = rawText;
      }
    }
    if (!content) {
      return c.json(
        {
          error: 'Plan content not found. The task may not have created a plan artifact yet.',
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

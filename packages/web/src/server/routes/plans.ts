// routes/plans.ts — API endpoint for fetching plan artifacts.
//
// This endpoint proxies to the manager's MCP tool `read_plan` which reads
// .percussionist/plans/{plan-task-id}.md from a completed run's workspace.

import { Hono } from 'hono';
import { auth } from '../auth.js';
import { NAMESPACE } from '../kube.js';
import { callManagerTool, ManagerMcpHttpError } from '../lib/manager-mcp.js';

const router = new Hono();

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
    const result = await callManagerTool('read_plan', {
      project,
      task: taskId,
      namespace: NAMESPACE,
    });

    // Extract the plan content from the MCP response.
    // The MCP server wraps all tool results as JSON.stringify(result), so
    // content[0].text is a JSON string like {"content":"## Plan...","exists":true,...}.
    // Parse it and extract the inner .content field.
    const rawText = result.content?.[0]?.text;
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
    // HTTP failures from the manager keep the 502 they had before the shared
    // client; JSON-RPC and transport errors map to 500.
    if (e instanceof ManagerMcpHttpError) {
      return c.json({ error: e.message }, 502);
    }
    const msg = (e as Error).message;
    return c.json({ error: msg, taskId, project }, 500);
  }
});

export default router;

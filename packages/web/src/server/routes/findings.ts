// routes/findings.ts — PATCH proxy to the manager's `update_finding` MCP tool.
//
// Lets the UI close/triage a board finding (resolve, won't-fix, duplicate,
// reopen, reclassify). The manager already owns the curated finding state in
// the {project}-findings ConfigMap and rebuilds board.status.findings, so this
// route is a thin, validated proxy — identical posture to routes/plans.ts and
// routes/project-memories.ts.

import { FindingCategory, FindingSeverity, FindingStatus } from '@percussionist/api';
import { Hono } from 'hono';
import { adminAuth } from '../auth.js';
import {
  callManagerTool,
  ManagerMcpHttpError,
  type ManagerToolResult,
} from '../lib/manager-mcp.js';

const router = new Hono();

// PATCH /api/projects/:name/findings/:id
//
// Body: { status?, severity?, category? }. At least one field must be supplied,
// and any supplied value must be a valid enum member (the manager validates too,
// but we fail fast client-side to give an immediate 400). The manager result
// payload `{ project, finding, updated }` is returned as JSON.
router.patch('/:name/findings/:id', adminAuth(), async (c) => {
  const name = c.req.param('name');
  const id = c.req.param('id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const status = typeof body.status === 'string' ? body.status : undefined;
  const severity = typeof body.severity === 'string' ? body.severity : undefined;
  const category = typeof body.category === 'string' ? body.category : undefined;

  // At least one field must be supplied.
  if (status === undefined && severity === undefined && category === undefined) {
    return c.json(
      { error: "At least one of 'status', 'severity', or 'category' is required" },
      400,
    );
  }

  // Fail fast on invalid (non-empty) values.
  if (status !== undefined && status !== '' && !FindingStatus.safeParse(status).success) {
    return c.json({ error: `Invalid status: ${status}` }, 400);
  }
  if (severity !== undefined && severity !== '' && !FindingSeverity.safeParse(severity).success) {
    return c.json({ error: `Invalid severity: ${severity}` }, 400);
  }
  if (category !== undefined && category !== '' && !FindingCategory.safeParse(category).success) {
    return c.json({ error: `Invalid category: ${category}` }, 400);
  }

  const args: Record<string, unknown> = { project: name, id };
  if (status) args.status = status;
  if (severity) args.severity = severity;
  if (category) args.category = category;

  try {
    const result = await callManagerTool('update_finding', args);
    return c.json(parseUpdateResult(result));
  } catch (e) {
    // HTTP failures from the manager map to 502; JSON-RPC / transport errors to 500.
    if (e instanceof ManagerMcpHttpError) {
      return c.json({ error: e.message }, 502);
    }
    const msg = (e as Error).message;
    return c.json({ error: msg }, 500);
  }
});

// POST /api/projects/:name/findings/:id/promote
//
// Body: { agent?, priority? }. Promotion is delegated to the manager's
// `create_task_from_finding` tool; the manager picks the task type (PLAN for
// security/debt, BUILD otherwise), the default agent, and the priority when
// omitted. Any supplied `priority` must be a valid enum member — the manager
// validates too, but we fail fast client-side to give an immediate 400. The
// manager result payload `{ project, taskName, findingId, type, agent, priority }`
// is returned as JSON.
const PRIORITIES = ['high', 'medium', 'low'] as const;

router.post('/:name/findings/:id/promote', adminAuth(), async (c) => {
  const name = c.req.param('name');
  const id = c.req.param('id');

  let body: Record<string, unknown> = {};
  const raw = await c.req.text();
  if (raw) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
  }

  const agent = typeof body.agent === 'string' ? body.agent : undefined;
  const priority = typeof body.priority === 'string' ? body.priority : undefined;

  // Fail fast on invalid (non-empty) priority.
  if (
    priority !== undefined &&
    priority !== '' &&
    !PRIORITIES.includes(priority as (typeof PRIORITIES)[number])
  ) {
    return c.json({ error: `Invalid priority: ${priority}` }, 400);
  }

  const args: Record<string, unknown> = { project: name, id };
  if (agent) args.agent = agent;
  if (priority) args.priority = priority;

  try {
    const result = await callManagerTool('create_task_from_finding', args);
    return c.json(parseUpdateResult(result));
  } catch (e) {
    // HTTP failures from the manager map to 502; JSON-RPC / transport errors to 500.
    if (e instanceof ManagerMcpHttpError) {
      return c.json({ error: e.message }, 502);
    }
    const msg = (e as Error).message;
    return c.json({ error: msg }, 500);
  }
});

// The manager wraps the tool result as JSON.stringify(result), so
// content[0].text is the JSON string `{"project","finding","updated"}`. Parse it
// and return the inner object; fall back to a bare result if it is not JSON.
function parseUpdateResult(result: ManagerToolResult): unknown {
  const rawText = result.content?.[0]?.text;
  if (rawText) {
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      // Not JSON — return the raw tool result as-is.
      return result;
    }
  }
  return result;
}

export default router;

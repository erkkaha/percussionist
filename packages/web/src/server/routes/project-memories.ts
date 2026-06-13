// routes/project-memories.ts — Project-scoped memory CRUD proxy routes.
//
// These routes proxy to the per-project memory service (memory-{project}.{ns}.svc.cluster.local)
// which runs Bun on port 4100 with sqlite-vec for vector storage and search.

import { Hono } from 'hono';
import { adminAuth, auth } from '../auth.js';
import { NAMESPACE } from '../kube.js';

const router = new Hono();

// ---------------------------------------------------------------------------
// Memory service DNS — per-project memory-{project}.{namespace}.svc.cluster.local:4100

function memoryServiceUrl(project: string): string {
  return `http://memory-${project}.${NAMESPACE}.svc.cluster.local:4100`;
}

// GET /api/projects/:name/memories — list memories (proxy to memory service)
router.get('/:name/memories', auth(), async (c) => {
  const project = c.req.param('name');
  const limit = c.req.query('limit');
  const offset = c.req.query('offset');
  const task = c.req.query('task');

  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  if (task) params.set('task', task);

  try {
    const res = await fetch(`${memoryServiceUrl(project)}/memories?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return c.json({ error: `Memory service returned ${res.status}` }, 502);
    }

    const data = await res.json();
    return c.json(data);
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, 500);
  }
});

// GET /api/projects/:name/memories/:id — get single memory by ID
router.get('/:name/memories/:id', auth(), async (c) => {
  const project = c.req.param('name');
  const id = c.req.param('id');

  try {
    const res = await fetch(`${memoryServiceUrl(project)}/memory/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return c.json({ error: `Memory service returned ${res.status}` }, 502);
    }

    const data = await res.json();
    return c.json(data);
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, 500);
  }
});

// POST /api/projects/:name/memories — create a new memory
router.post('/:name/memories', adminAuth(), async (c) => {
  const project = c.req.param('name');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  if (!body.content || typeof body.content !== 'string') {
    return c.json({ error: 'content is required and must be a string' }, 400);
  }

  try {
    const res = await fetch(`${memoryServiceUrl(project)}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: body.content,
        metadata: body.metadata as Record<string, unknown> | undefined,
        agentRun: body.agentRun as string | undefined,
      }),
      signal: AbortSignal.timeout(60_000), // embedding generation can be slow
    });

    if (!res.ok) {
      return c.json({ error: `Memory service returned ${res.status}` }, 502);
    }

    const data = await res.json();
    return c.json(data, 201);
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, 500);
  }
});

// PATCH /api/projects/:name/memories/:id — update a memory
router.patch('/:name/memories/:id', adminAuth(), async (c) => {
  const project = c.req.param('name');
  const id = c.req.param('id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  // At least one of content or metadata must be provided
  if (body.content === undefined && body.metadata === undefined) {
    return c.json({ error: "At least one of 'content' or 'metadata' is required" }, 400);
  }

  try {
    const res = await fetch(`${memoryServiceUrl(project)}/memory/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: body.content as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      }),
      signal: AbortSignal.timeout(60_000), // embedding refresh can be slow
    });

    if (!res.ok) {
      return c.json({ error: `Memory service returned ${res.status}` }, 502);
    }

    const data = await res.json();
    return c.json(data);
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, 500);
  }
});

// DELETE /api/projects/:name/memories/:id — delete a memory
router.delete('/:name/memories/:id', adminAuth(), async (c) => {
  const project = c.req.param('name');
  const id = c.req.param('id');

  try {
    const res = await fetch(`${memoryServiceUrl(project)}/memory/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return c.json({ error: `Memory service returned ${res.status}` }, 502);
    }

    const data = await res.json();
    return c.json(data);
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, 500);
  }
});

export default router;

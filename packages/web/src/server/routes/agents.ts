import { API_GROUP_VERSION, ClusterAgentSpecSchema, KIND_CLUSTER_AGENT } from '@percussionist/api';
import { Hono } from 'hono';
import { adminAuth, auth } from '../auth.js';
import {
  createClusterAgent,
  deleteClusterAgent,
  getClusterAgent,
  listClusterAgents,
  updateClusterAgent,
} from '../kube.js';
import { createPollingSseResponse } from '../lib/sse.js';

const agents = new Hono();

// GET /api/agents — list all cluster-scoped agents.
agents.get('/', auth(), async (c) => {
  try {
    const items = await listClusterAgents();
    return c.json({
      agents: items.map((a) => ({
        name: a.metadata.name ?? '',
        content: a.spec.content,
        model: a.spec.model,
        capabilities: a.spec.capabilities,
      })),
    });
  } catch (e: unknown) {
    const msg = (e as { body?: { message?: string } })?.body?.message ?? String(e);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/agents/events — SSE stream for agent list changes.
agents.get('/events', auth(), async (c) => {
  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () => {
      const items = await listClusterAgents();
      return JSON.stringify(
        items.map((a) => ({
          resourceVersion: a.metadata.resourceVersion,
          generation: a.metadata.generation,
          name: a.metadata.name,
          content: a.spec.content,
          model: a.spec.model,
          capabilities: a.spec.capabilities,
        })),
      );
    },
    updatedEvent: 'agents.updated',
    errorEvent: 'agents.error',
    readyEvent: { event: 'ready', data: { collection: 'agents' } },
  });
});

// GET /api/agents/:name — get a single agent.
agents.get('/:name', auth(), async (c) => {
  const name = c.req.param('name');
  try {
    const agent = await getClusterAgent(name);
    return c.json(agent);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, status);
  }
});

// POST /api/agents — create a new ClusterAgent.
agents.post('/', adminAuth(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = ClusterAgentSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
  }

  const name = (body as { name?: string }).name ?? `agent-${Date.now().toString(16)}`;

  const agent = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_CLUSTER_AGENT,
    metadata: { name },
    spec: parsed.data,
  };

  try {
    const created = await createClusterAgent(agent as Parameters<typeof createClusterAgent>[0]);
    return c.json(created, 201);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = (anyE.statusCode ?? 500) as 400 | 409 | 500;
    return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, status);
  }
});

// PUT /api/agents/:name — update an existing agent.
agents.put('/:name', adminAuth(), async (c) => {
  const name = c.req.param('name');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = ClusterAgentSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
  }

  try {
    const updated = await updateClusterAgent(name, parsed.data);
    return c.json(updated);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, status);
  }
});

// DELETE /api/agents/:name — delete an agent.
agents.delete('/:name', adminAuth(), async (c) => {
  const name = c.req.param('name');
  try {
    await deleteClusterAgent(name);
    return c.body(null, 204);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    return c.json(
      { error: anyE.body?.message ?? anyE.message ?? String(e) },
      (anyE.statusCode ?? 500) as 400 | 404 | 500,
    );
  }
});

export default agents;

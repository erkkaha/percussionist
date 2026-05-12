import { Hono } from "hono";
import {
  listClusterAgents,
  getClusterAgent,
  createClusterAgent,
  updateClusterAgent,
  deleteClusterAgent,
} from "../kube.js";
import {
  ClusterAgentSpecSchema,
  API_GROUP_VERSION,
  KIND_CLUSTER_AGENT,
} from "@percussionist/api";

const agents = new Hono();

// GET /api/agents — list all cluster-scoped agents.
agents.get("/", async (c) => {
  try {
    const items = await listClusterAgents();
    return c.json({ agents: items.map((a) => ({ name: a.metadata.name!, content: a.spec.content })) });
  } catch (e: unknown) {
    const msg = (e as { body?: { message?: string } })?.body?.message ?? String(e);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/agents/:name — get a single agent.
agents.get("/:name", async (c) => {
  const name = c.req.param("name");
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
agents.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = ClusterAgentSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
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
agents.put("/:name", async (c) => {
  const name = c.req.param("name");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = ClusterAgentSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
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
agents.delete("/:name", async (c) => {
  const name = c.req.param("name");
  try {
    await deleteClusterAgent(name);
    return c.body(null, 204);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, (anyE.statusCode ?? 500) as 400 | 404 | 500);
  }
});

export default agents;

import { Hono } from "hono";
import { listProjects, getProject, createProject, updateProject, deleteProject } from "../kube.js";
import {
  OpenCodeProjectSpecSchema,
  API_GROUP_VERSION,
  KIND_PROJECT,
} from "@percussionist/api";

const projects = new Hono();

// GET /api/projects
projects.get("/", async (c) => {
  try {
    const items = await listProjects();
    return c.json({ items });
  } catch (e: unknown) {
    const msg = (e as { body?: { message?: string } })?.body?.message ?? String(e);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/projects/:name
projects.get("/:name", async (c) => {
  const name = c.req.param("name");
  try {
    const project = await getProject(name);
    return c.json(project);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// POST /api/projects
projects.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = OpenCodeProjectSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }
  const spec = parsed.data;

  const name =
    (body as { name?: string }).name ??
    `project-${Date.now().toString(16)}`;

  const project = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_PROJECT,
    metadata: { name },
    spec,
  };

  try {
    const created = await createProject(project as Parameters<typeof createProject>[0]);
    return c.json(created, 201);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode ?? 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status as 400 | 409 | 500);
  }
});

// PUT /api/projects/:name
projects.put("/:name", async (c) => {
  const name = c.req.param("name");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = OpenCodeProjectSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }

  try {
    const updated = await updateProject(name, parsed.data);
    return c.json(updated);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// DELETE /api/projects/:name
projects.delete("/:name", async (c) => {
  const name = c.req.param("name");
  try {
    await deleteProject(name);
    return c.body(null, 204);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

export default projects;

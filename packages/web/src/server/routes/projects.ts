import { Hono } from "hono";
import { listProjects, getProject, createProject, updateProject, deleteProject, core, NAMESPACE } from "../kube.js";
import {
  OpenCodeProjectSpecSchema,
  API_GROUP_VERSION,
  KIND_PROJECT,
} from "@percussionist/api";

const projects = new Hono();

const CONFIG_CM_KEY = "opencode.json";
const CLUSTER_CONFIG_CM = "opencode-config";

/** Name of the per-project opencode config configmap. */
function projectConfigCmName(projectName: string): string {
  return `${projectName}-opencode-config`;
}

/**
 * Ensure the per-project opencode config configmap exists and has the given
 * content.  Creates it if absent, patches it if present.
 */
async function upsertProjectConfigCm(projectName: string, content: string): Promise<void> {
  const name = projectConfigCmName(projectName);
  const ns = NAMESPACE;
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace: ns, labels: { "percussionist.dev/project": projectName } },
    data: { [CONFIG_CM_KEY]: content },
  };
  try {
    await core().readNamespacedConfigMap({ name, namespace: ns });
    // exists — replace
    await core().replaceNamespacedConfigMap({ name, namespace: ns, body });
  } catch {
    // not found — create
    await core().createNamespacedConfigMap({ namespace: ns, body });
  }
}

async function deleteProjectConfigCm(projectName: string): Promise<void> {
  const name = projectConfigCmName(projectName);
  try {
    await core().deleteNamespacedConfigMap({ name, namespace: NAMESPACE });
  } catch {
    // ignore not-found
  }
}

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

// GET /api/projects/config/default — returns cluster-wide opencode-config content
projects.get("/config/default", async (c) => {
  try {
    const cm = await core().readNamespacedConfigMap({ name: CLUSTER_CONFIG_CM, namespace: NAMESPACE });
    return c.json(cm.data?.[CONFIG_CM_KEY] ?? "");
  } catch {
    return c.json("");
  }
});

// GET /api/projects/:name/config — returns per-project opencode.json, falls back to cluster-wide
projects.get("/:name/config", async (c) => {
  const name = c.req.param("name");
  const ns = NAMESPACE;
  // Try per-project configmap first.
  try {
    const cm = await core().readNamespacedConfigMap({ name: projectConfigCmName(name), namespace: ns });
    return c.json(cm.data?.[CONFIG_CM_KEY] ?? "");
  } catch {
    // fall through to cluster-wide
  }
  // Fall back to cluster-wide opencode-config.
  try {
    const cm = await core().readNamespacedConfigMap({ name: CLUSTER_CONFIG_CM, namespace: ns });
    return c.json(cm.data?.[CONFIG_CM_KEY] ?? "");
  } catch {
    return c.json("");
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

  const opencodeConfig = (body as { opencodeConfig?: string }).opencodeConfig ?? "";

  const parsed = OpenCodeProjectSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }
  const spec = parsed.data;

  const name =
    (body as { name?: string }).name ??
    `project-${Date.now().toString(16)}`;

  // If opencode config content provided, create the configmap and wire it up.
  if (opencodeConfig.trim()) {
    await upsertProjectConfigCm(name, opencodeConfig.trim());
    spec.secrets = {
      ...spec.secrets,
      opencodeConfigMap: { name: projectConfigCmName(name), key: CONFIG_CM_KEY },
    };
  }

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

  const opencodeConfig = (body as { opencodeConfig?: string }).opencodeConfig ?? "";

  const parsed = OpenCodeProjectSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }
  const spec = parsed.data;

  // Manage per-project configmap.
  if (opencodeConfig.trim()) {
    await upsertProjectConfigCm(name, opencodeConfig.trim());
    spec.secrets = {
      ...spec.secrets,
      opencodeConfigMap: { name: projectConfigCmName(name), key: CONFIG_CM_KEY },
    };
  } else {
    // Clear: remove configmap and unset the field.
    await deleteProjectConfigCm(name);
    if (spec.secrets?.opencodeConfigMap) {
      const { opencodeConfigMap: _, ...rest } = spec.secrets;
      void _;
      spec.secrets = Object.keys(rest).length ? rest : undefined;
    }
  }

  try {
    const updated = await updateProject(name, spec);
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
    // Best-effort cleanup of per-project config configmap.
    await deleteProjectConfigCm(name);
    return c.body(null, 204);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

export default projects;

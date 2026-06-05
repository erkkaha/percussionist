import { Hono } from "hono";
import { listProjects, getProject, createProject, updateProject, deleteProject, core, NAMESPACE } from "../kube.js";
import { createPollingSseResponse } from "../lib/sse.js";
import {
  ProjectSpecSchema,
  API_GROUP_VERSION,
  KIND_PROJECT,
  type InjectFileRef,
} from "@percussionist/api";
import { auth, adminAuth } from "../auth.js";

const projects = new Hono();

const CONFIG_CM_KEY = "opencode.json";
const CLUSTER_CONFIG_CM = "opencode-config";
const INJECT_FILE_SECRET_KEY = "content";

/** Name of the per-project opencode config configmap. */
function projectConfigCmName(projectName: string): string {
  return `${projectName}-opencode-config`;
}

/** Name of the per-project inject-file Secret for a given filename. */
function injectFileSecretName(projectName: string, filename: string): string {
  // Sanitise the filename into a valid K8s name segment (replace dots/underscores, lowercase).
  const slug = filename.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${projectName}-inject-${slug}`;
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

/**
 * Upsert a K8s Secret holding a single file's raw content.
 * Returns the InjectFileRef (secretRef) to store in spec.injectFiles.
 */
async function upsertInjectFileSecret(
  projectName: string,
  filename: string,
  content: string,
): Promise<InjectFileRef> {
  const name = injectFileSecretName(projectName, filename);
  const ns = NAMESPACE;
  const body = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace: ns, labels: { "percussionist.dev/project": projectName } },
    stringData: { [INJECT_FILE_SECRET_KEY]: content },
  };
  try {
    await core().readNamespacedSecret({ name, namespace: ns });
    await core().replaceNamespacedSecret({ name, namespace: ns, body });
  } catch {
    await core().createNamespacedSecret({ namespace: ns, body });
  }
  return { filename, secretRef: { name, key: INJECT_FILE_SECRET_KEY } };
}

/**
 * Delete inject-file Secrets for filenames that are no longer referenced.
 */
async function deleteOrphanedInjectFileSecrets(
  projectName: string,
  previousRefs: InjectFileRef[],
  currentFilenames: Set<string>,
): Promise<void> {
  for (const ref of previousRefs) {
    if (!currentFilenames.has(ref.filename)) {
      try {
        await core().deleteNamespacedSecret({ name: ref.secretRef.name, namespace: NAMESPACE });
      } catch {
        // ignore
      }
    }
  }
}

/** Read the content of all inject-file Secrets for a project. */
async function readInjectFileContents(
  injectFiles: InjectFileRef[],
): Promise<Array<{ filename: string; content: string }>> {
  return Promise.all(
    injectFiles.map(async (f) => {
      try {
        const secret = await core().readNamespacedSecret({ name: f.secretRef.name, namespace: NAMESPACE });
        // K8s returns Secret data base64-encoded.
        const raw = secret.data?.[f.secretRef.key] ?? "";
        const content = typeof raw === "string" ? Buffer.from(raw, "base64").toString("utf8") : "";
        return { filename: f.filename, content };
      } catch {
        return { filename: f.filename, content: "" };
      }
    }),
  );
}

// GET /api/projects
projects.get("/", auth(), async (c) => {
  try {
    const items = await listProjects();
    return c.json({ items });
  } catch (e: unknown) {
    const msg = (e as { body?: { message?: string } })?.body?.message ?? String(e);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/projects/events — SSE stream for project list changes.
projects.get("/events", auth(), async (c) => {
  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () => JSON.stringify((await listProjects()).map((p) => ({
      resourceVersion: p.metadata.resourceVersion,
      generation: p.metadata.generation,
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      displayName: p.spec.displayName,
      model: p.spec.model,
      agent: p.spec.agent,
      gitUrl: p.spec.source?.git?.url,
      gitRef: p.spec.source?.git?.ref,
    }))),
    updatedEvent: "projects.updated",
    errorEvent: "projects.error",
    readyEvent: { event: "ready", data: { collection: "projects" } },
  });
});

// GET /api/projects/config/default — returns cluster-wide opencode-config content
projects.get("/config/default", auth(), async (c) => {
  try {
    const cm = await core().readNamespacedConfigMap({ name: CLUSTER_CONFIG_CM, namespace: NAMESPACE });
    return c.json(cm.data?.[CONFIG_CM_KEY] ?? "");
  } catch {
    return c.json("");
  }
});

// GET /api/projects/:name/config — returns per-project opencode.json, falls back to cluster-wide
projects.get("/:name/config", auth(), async (c) => {
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
projects.get("/:name", auth(), async (c) => {
  const name = c.req.param("name");
  try {
    const project = await getProject(name);
    // Augment response with inject file contents so the UI can pre-populate.
    const injectFileContents = project.spec.injectFiles?.length
      ? await readInjectFileContents(project.spec.injectFiles)
      : [];
    return c.json({ ...project, injectFileContents });
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// POST /api/projects
projects.post("/", adminAuth(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const opencodeConfig = (body as { opencodeConfig?: string }).opencodeConfig ?? "";
  // Out-of-band inject files: [{ filename, content }]
  const rawInjectFiles = (body as { injectFiles?: Array<{ filename: string; content: string }> }).injectFiles ?? [];

  // Strip out-of-band fields before schema validation.
  const { opencodeConfig: _oc, injectFiles: _if, name: _n, ...specBody } = body as Record<string, unknown>;
  void _oc; void _if; void _n;

  const parsed = ProjectSpecSchema.safeParse(specBody);
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
      configMap: { name: projectConfigCmName(name), key: CONFIG_CM_KEY },
    };
  }

  // Upsert inject-file Secrets and wire up spec.injectFiles.
  if (rawInjectFiles.length > 0) {
    const refs = await Promise.all(
      rawInjectFiles
        .filter((f) => f.filename.trim())
        .map((f) => upsertInjectFileSecret(name, f.filename.trim(), f.content)),
    );
    spec.injectFiles = refs;
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
projects.put("/:name", adminAuth(), async (c) => {
  const name = c.req.param("name");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const opencodeConfig = (body as { opencodeConfig?: string }).opencodeConfig ?? "";
  // Out-of-band inject files: [{ filename, content }]
  const rawInjectFiles = (body as { injectFiles?: Array<{ filename: string; content: string }> }).injectFiles ?? [];

  // Strip out-of-band fields before schema validation.
  const { opencodeConfig: _oc2, injectFiles: _if2, name: _n2, ...specBody2 } = body as Record<string, unknown>;
  void _oc2; void _if2; void _n2;

  // Fetch existing project to preserve fields not sent by the UI (like featureBranchingEnabled)
  let existingSpec: Partial<typeof specBody2> = {};
  try {
    const existing = await getProject(name);
    existingSpec = existing.spec as Partial<typeof specBody2>;
  } catch {
    // Project doesn't exist yet, proceed with empty existing spec
  }

  // Merge existing spec with incoming spec (incoming takes precedence).
  // For sidecars: deep-merge by name so that fields the UI doesn't know about
  // (e.g. securityContext.privileged, resources) are preserved from the existing
  // spec when a matching sidecar name is found.
  const mergedSpec = { ...existingSpec, ...specBody2 };
  if (Array.isArray((specBody2 as Record<string, unknown>).sidecars) && Array.isArray((existingSpec as Record<string, unknown>).sidecars)) {
    const existingSidecars = (existingSpec as Record<string, unknown>).sidecars as Array<Record<string, unknown>>;
    const incomingSidecars = (specBody2 as Record<string, unknown>).sidecars as Array<Record<string, unknown>>;
    mergedSpec.sidecars = incomingSidecars.map((incoming) => {
      const existing = existingSidecars.find((e) => e.name === incoming.name);
      return existing ? { ...existing, ...incoming } : incoming;
    });
  }

  const parsed = ProjectSpecSchema.safeParse(mergedSpec);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }
  const spec = parsed.data;

  // Manage per-project configmap.
  if (opencodeConfig.trim()) {
    await upsertProjectConfigCm(name, opencodeConfig.trim());
    spec.secrets = {
      ...spec.secrets,
      configMap: { name: projectConfigCmName(name), key: CONFIG_CM_KEY },
    };
  } else {
    // Clear: remove configmap and unset the field.
    await deleteProjectConfigCm(name);
    if (spec.secrets?.configMap) {
      const { configMap: _, ...rest } = spec.secrets;
      void _;
      spec.secrets = Object.keys(rest).length ? rest : undefined;
    }
  }

  // Manage inject-file Secrets: upsert new/updated, delete orphans.
  const previousRefs = spec.injectFiles ?? [];
  const validInjectFiles = rawInjectFiles.filter((f) => f.filename.trim());
  const currentFilenames = new Set(validInjectFiles.map((f) => f.filename.trim()));
  await deleteOrphanedInjectFileSecrets(name, previousRefs, currentFilenames);
  if (validInjectFiles.length > 0) {
    const refs = await Promise.all(
      validInjectFiles.map((f) => upsertInjectFileSecret(name, f.filename.trim(), f.content)),
    );
    spec.injectFiles = refs;
  } else {
    spec.injectFiles = undefined;
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
projects.delete("/:name", adminAuth(), async (c) => {
  const name = c.req.param("name");
  try {
    // Fetch project first so we know which inject-file Secrets to clean up.
    let injectFileRefs: InjectFileRef[] = [];
    try {
      const project = await getProject(name);
      injectFileRefs = project.spec.injectFiles ?? [];
    } catch {
      // project not found — proceed with delete anyway
    }
    await deleteProject(name);
    // Best-effort cleanup of per-project config configmap.
    await deleteProjectConfigCm(name);
    // Best-effort cleanup of inject-file Secrets.
    for (const ref of injectFileRefs) {
      try {
        await core().deleteNamespacedSecret({ name: ref.secretRef.name, namespace: NAMESPACE });
      } catch {
        // ignore
      }
    }
    return c.body(null, 204);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

export default projects;

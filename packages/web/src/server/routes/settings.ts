import { ClusterSettingsSpecSchema } from '@percussionist/api';
import { Hono } from 'hono';
import { adminAuth, auth } from '../auth.js';
import { core, getClusterSettings, NAMESPACE, updateClusterSettings } from '../kube.js';

const settings = new Hono();

const CLUSTER_CONFIG_CM = 'opencode-config';
const CONFIG_CM_KEY = 'opencode.json';
const AGENT_CONFIG_CM = 'agent-config';
const DECISION_AGENT_CM_KEY = 'manager-decision.md';

// ---------------------------------------------------------------------------
// Helpers

async function upsertSecret(name: string, data: Record<string, string>): Promise<void> {
  const ns = NAMESPACE;
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: ns },
    stringData: data,
  };
  try {
    await core().readNamespacedSecret({ name, namespace: ns });
    await core().replaceNamespacedSecret({ name, namespace: ns, body });
  } catch {
    await core().createNamespacedSecret({ namespace: ns, body });
  }
}

async function deleteSecret(name: string): Promise<void> {
  try {
    await core().deleteNamespacedSecret({ name, namespace: NAMESPACE });
  } catch {
    // ignore not-found
  }
}

// ---------------------------------------------------------------------------
// GET /api/settings — read ClusterSettings/default

settings.get('/', auth(), async (c) => {
  try {
    const cs = await getClusterSettings('default');
    return c.json(cs);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number };
    if ((anyE as { statusCode?: number }).statusCode === 404) {
      return c.json({ metadata: { name: 'default' }, spec: {} }, 200);
    }
    return c.json({ error: String(e) }, 500);
  }
});

// PUT /api/settings — update ClusterSettings/default

settings.put('/', adminAuth(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = ClusterSettingsSpecSchema.safeParse((body as { spec?: unknown })?.spec ?? body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
  }

  try {
    const updated = await updateClusterSettings('default', parsed.data);
    return c.json(updated);
  } catch (e: unknown) {
    return c.json({ error: String(e) }, 500);
  }
});

// GET /api/settings/opencode-config — read the resolved opencode.json

settings.get('/opencode-config', auth(), async (c) => {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: CLUSTER_CONFIG_CM,
      namespace: NAMESPACE,
    });
    return c.json(cm.data?.[CONFIG_CM_KEY] ?? '');
  } catch {
    return c.json('');
  }
});

// GET /api/settings/decision-agent-default — read the resolved decision agent content
// from the agent-config ConfigMap, which the operator populates with the effective
// content (user override or hardcoded default).

settings.get('/decision-agent-default', auth(), async (c) => {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: AGENT_CONFIG_CM,
      namespace: NAMESPACE,
    });
    const content = cm.data?.[DECISION_AGENT_CM_KEY] ?? '';
    return c.json({ content });
  } catch {
    return c.json({ content: '' });
  }
});

// GET /api/settings/secrets — list Secrets matching our label pattern

settings.get('/secrets', auth(), async (c) => {
  try {
    const res = await core().listNamespacedSecret({ namespace: NAMESPACE });
    const items = (res.items ?? []).map((s) => ({
      name: s.metadata?.name ?? '',
      labels: s.metadata?.labels ?? {},
      keys: Object.keys(s.data ?? {}),
    }));
    return c.json({ items });
  } catch (e: unknown) {
    return c.json({ error: String(e) }, 500);
  }
});

// POST /api/settings/secrets — create a Secret

settings.post('/secrets', adminAuth(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { name, data } = body as { name?: string; data?: Record<string, string> };
  if (!name?.trim()) return c.json({ error: 'name is required' }, 400);
  if (!data || Object.keys(data).length === 0) {
    return c.json({ error: 'data (key-value pairs) is required' }, 400);
  }

  try {
    await upsertSecret(name.trim(), data);
    return c.json({ name, data: Object.keys(data) }, 201);
  } catch (e: unknown) {
    return c.json({ error: String(e) }, 500);
  }
});

// PUT /api/settings/secrets/:name — update a Secret's data

settings.put('/secrets/:name', adminAuth(), async (c) => {
  const name = c.req.param('name');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { data } = body as { data?: Record<string, string> };
  if (!data || Object.keys(data).length === 0) {
    return c.json({ error: 'data (key-value pairs) is required' }, 400);
  }

  try {
    await upsertSecret(name, data);
    return c.json({ name, data: Object.keys(data) });
  } catch (e: unknown) {
    return c.json({ error: String(e) }, 500);
  }
});

// DELETE /api/settings/secrets/:name

settings.delete('/secrets/:name', adminAuth(), async (c) => {
  const name = c.req.param('name');
  try {
    await deleteSecret(name);
    return c.body(null, 204);
  } catch (e: unknown) {
    return c.json({ error: String(e) }, 500);
  }
});

export default settings;

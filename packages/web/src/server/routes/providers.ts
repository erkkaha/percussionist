// routes/providers.ts — fetches available LLM providers/models by invoking the
// manager's list_models MCP tool on port 4097.
//
// The claude-code engine is appended separately: it is not an opencode provider,
// so the sidecar's list_models knows nothing about it. It is only advertised when
// a subscription token actually exists in the namespace — offering a provider
// that cannot authenticate is worse than not offering it, since the failure would
// only surface as a 401 partway into a run.

import { CLAUDE_ENGINE_PROVIDER_ID, CLAUDE_RUNNER_DEFAULTS } from '@percussionist/api';
import { Hono } from 'hono';
import { auth } from '../auth.js';
import { core, NAMESPACE } from '../kube.js';
import { callManagerTool } from '../lib/manager-mcp.js';

const router = new Hono();

/**
 * Models offered for the claude-code engine.
 *
 * Static by necessity: there is no runner to interrogate until a run pod exists,
 * and the CLI exposes no model-listing command. The *provider's* availability is
 * dynamic (see claudeEngineAvailable) — only this list is fixed. Users can still
 * type any model ID the CLI accepts; the selector is a convenience, not a gate.
 */
const CLAUDE_ENGINE_MODELS = [
  { id: 'claude-opus-5', name: 'Opus 5' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
  { id: 'claude-fable-5', name: 'Fable 5' },
];

/**
 * True when some Secret in the namespace carries a subscription token.
 *
 * Only key *names* are inspected, never values — the same approach as
 * GET /api/settings/secrets. A failure to list is treated as "unavailable" so a
 * transient API error hides the provider rather than advertising one that may not
 * work.
 */
async function claudeEngineAvailable(): Promise<boolean> {
  try {
    const res = await core().listNamespacedSecret({ namespace: NAMESPACE });
    return (res.items ?? []).some((s) =>
      Object.keys(s.data ?? {}).includes(CLAUDE_RUNNER_DEFAULTS.authEnvVar),
    );
  } catch {
    return false;
  }
}

// GET /api/providers — list all providers, connected status, and defaults.
type ProvidersPayload = {
  all?: Array<Record<string, unknown>>;
  connected?: string[];
  default?: Record<string, string>;
};

const CLAUDE_ENGINE_PROVIDER = {
  id: CLAUDE_ENGINE_PROVIDER_ID,
  name: 'Claude Code (subscription)',
  models: CLAUDE_ENGINE_MODELS,
};

/**
 * Append the claude-code provider when a token exists.
 *
 * It has to land in `connected` as well as `all` — ModelSelector filters `all`
 * down to connected providers, so an entry added to `all` alone is silently
 * dropped again.
 *
 * Exported so tests can assert against the real composition step instead of a
 * local reimplementation.
 */
export function withClaudeEngine(data: ProvidersPayload): ProvidersPayload {
  return {
    ...data,
    all: [...(data.all ?? []), CLAUDE_ENGINE_PROVIDER],
    connected: [...(data.connected ?? []), CLAUDE_ENGINE_PROVIDER_ID],
  };
}

/** Fetch opencode's provider list, or null when the sidecar cannot answer. */
async function fetchOpencodeProviders(): Promise<ProvidersPayload | null> {
  try {
    const result = await callManagerTool('list_models', {}, 10_000);
    if (result.isError) return null;

    const text = result.content?.find((p) => p.type === 'text')?.text;
    if (!text) return null;
    return JSON.parse(text) as ProvidersPayload;
  } catch {
    return null;
  }
}

router.get('/', auth(), async (c) => {
  const [opencode, claudeAvailable] = await Promise.all([
    fetchOpencodeProviders(),
    claudeEngineAvailable(),
  ]);

  if (opencode) {
    return c.json(claudeAvailable ? withClaudeEngine(opencode) : opencode);
  }

  // The opencode sidecar is unreachable. A cluster running only the claude
  // engine has no sidecar to reach at all, so 502-ing here would leave it with
  // no model list whatsoever — degrade to the claude provider alone instead.
  if (claudeAvailable) {
    return c.json(withClaudeEngine({ all: [], connected: [], default: {} }));
  }

  return c.json({ error: 'provider list unavailable: opencode sidecar unreachable' }, 502);
});

export default router;

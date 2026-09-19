// config.ts — assemble the OpenCode 2 host configuration from the same inputs
// the v1 runner received, so the operator needs no engine-specific plumbing.
//
//   OPENCODE_CONFIG_CONTENT  cluster opencode.json (providers, models, mcp) —
//                            v1 schema; the SDK normalizes it (provider→providers,
//                            npm→package, options→settings, mcp→mcp.servers).
//   OPENCODE_AUTH_CONTENT    v1 auth.json: { "<provider>": { type, key | oauth… } }
//   agents/*.md              ClusterAgent files mounted by the operator, in
//                            opencode's agent-file format (frontmatter + prompt).
//
// Two things v2 no longer does for us:
//   - It has no OPENCODE_AUTH_CONTENT. Credentials live in its database, and
//     the embedded host's database is in-memory. API keys are therefore
//     injected as provider settings in the config document; the auth file is
//     also materialized at the legacy path so v2's legacy-credential import can
//     pick up anything else (OAuth entries) if it runs.
//   - Agent files in the XDG config directory were not observed to load in
//     2.0.10 (see the spike notes), so agents are inlined under the legacy
//     `agent` key, which v2 migrates to `agents`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type AgentFile = { name: string; content: string };

export type BuildConfigOptions = {
  configContent?: string;
  authContent?: string;
  agentFiles?: AgentFile[];
  /** When set, guarantees an MCP entry pointing at the dispatcher. */
  dispatcherMcpUrl?: string;
};

export type BuildConfigResult = {
  /** JSON document for OpenCode.create({ config: { content } }). */
  content: string;
  /** Human-readable notes: what was injected, what could not be. */
  notes: string[];
  warnings: string[];
};

type Json = Record<string, unknown>;

function asObject(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Frontmatter keys copied onto the agent definition. Anything else is dropped. */
const AGENT_KEYS = [
  'description',
  'mode',
  'model',
  'temperature',
  'top_p',
  'permission',
  'tools',
  'disable',
  'color',
  'steps',
] as const;

export type ParsedAgent = { name?: string; body: string; fields: Json };

export function parseAgentFile(content: string): ParsedAgent {
  const match = FRONTMATTER.exec(content);
  if (!match) return { body: content.trim(), fields: {} };
  const body = content.slice(match[0].length).trim();
  let fields: Json = {};
  try {
    fields = asObject(parseYaml(match[1] ?? ''));
  } catch {
    // Unparseable frontmatter: keep the prompt, lose the metadata. A prompt-only
    // agent is more useful than no agent.
  }
  const name = typeof fields.name === 'string' ? fields.name : undefined;
  return { name, body, fields };
}

/** Build the legacy-`agent` config entry for one mounted agent file. */
export function agentConfigEntry(parsed: ParsedAgent): Json {
  const entry: Json = {};
  for (const k of AGENT_KEYS) {
    if (parsed.fields[k] !== undefined) entry[k] = parsed.fields[k];
  }
  if (parsed.body) entry.prompt = parsed.body;
  return entry;
}

export function buildConfigContent(opts: BuildConfigOptions): BuildConfigResult {
  const notes: string[] = [];
  const warnings: string[] = [];

  let config: Json = {};
  if (opts.configContent && opts.configContent.trim() !== '') {
    try {
      config = asObject(JSON.parse(opts.configContent));
      notes.push(
        `config: ${Object.keys(config).length} top-level key(s) from OPENCODE_CONFIG_CONTENT`,
      );
    } catch (e) {
      warnings.push(
        `config: OPENCODE_CONFIG_CONTENT is not valid JSON — ignored (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  // --- credentials → provider settings ---------------------------------------
  if (opts.authContent && opts.authContent.trim() !== '') {
    let auth: Json = {};
    try {
      auth = asObject(JSON.parse(opts.authContent));
    } catch (e) {
      warnings.push(
        `auth: OPENCODE_AUTH_CONTENT is not valid JSON — ignored (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const providers = asObject(config.provider);
    for (const [providerID, raw] of Object.entries(auth)) {
      const entry = asObject(raw);
      if (entry.type === 'api' && typeof entry.key === 'string') {
        const provider = asObject(providers[providerID]);
        const options = asObject(provider.options);
        if (typeof options.apiKey === 'string' && options.apiKey !== '') {
          notes.push(
            `auth: ${providerID} already has options.apiKey in config — auth.json key not applied`,
          );
        } else {
          providers[providerID] = { ...provider, options: { ...options, apiKey: entry.key } };
          notes.push(`auth: ${providerID} api key injected as provider option`);
        }
      } else {
        warnings.push(
          `auth: ${providerID} credential of type "${String(entry.type)}" cannot be injected into the embedded host; relying on the legacy auth.json import`,
        );
      }
    }
    if (Object.keys(providers).length > 0) config.provider = providers;
  }

  // --- dispatcher MCP ----------------------------------------------------------
  if (opts.dispatcherMcpUrl) {
    const mcp = asObject(config.mcp);
    const present = Object.values(mcp).some((v) => asObject(v).url === opts.dispatcherMcpUrl);
    if (!present) {
      mcp['percussionist-dispatcher'] = {
        type: 'remote',
        url: opts.dispatcherMcpUrl,
        enabled: true,
      };
      notes.push(`mcp: added percussionist-dispatcher → ${opts.dispatcherMcpUrl}`);
    }
    config.mcp = mcp;
  }

  // --- agents ------------------------------------------------------------------
  if (opts.agentFiles && opts.agentFiles.length > 0) {
    const agents = asObject(config.agent);
    for (const file of opts.agentFiles) {
      const parsed = parseAgentFile(file.content);
      const name = parsed.name ?? file.name;
      if (!name) continue;
      if (agents[name] !== undefined) {
        notes.push(`agent: ${name} already defined in config — mounted file not applied`);
        continue;
      }
      agents[name] = agentConfigEntry(parsed);
    }
    config.agent = agents;
    notes.push(`agents: ${Object.keys(agents).join(', ') || '(none)'}`);
  }

  return { content: JSON.stringify(config), notes, warnings };
}

/** The `type: api` entries of a v1 auth.json, for RunnerHost credential registration. */
export function apiCredentials(
  authContent: string | undefined,
): Array<{ providerID: string; key: string }> {
  if (!authContent || authContent.trim() === '') return [];
  let auth: Json;
  try {
    auth = asObject(JSON.parse(authContent));
  } catch {
    return [];
  }
  const out: Array<{ providerID: string; key: string }> = [];
  for (const [providerID, raw] of Object.entries(auth)) {
    const entry = asObject(raw);
    if (entry.type === 'api' && typeof entry.key === 'string' && entry.key !== '') {
      out.push({ providerID, key: entry.key });
    }
  }
  return out;
}

/**
 * Write the v1 auth blob where OpenCode 2 looks for legacy credentials
 * (`<data dir>/opencode/auth.json`). Returns the path written, or undefined.
 */
export function materializeAuthFile(
  authContent: string | undefined,
  dataDir?: string,
): string | undefined {
  if (!authContent || authContent.trim() === '') return undefined;
  const base =
    dataDir ?? process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? homedir(), '.local', 'share');
  const path = join(base, 'opencode', 'auth.json');
  try {
    JSON.parse(authContent);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, authContent, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

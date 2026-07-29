// adapters/claude-config.ts — translate ClusterAgent definitions from opencode's
// agent-file format into what Claude Code reads.
//
// ClusterAgent.spec.content is an opencode agent file:
//
//   ---
//   name: builder
//   mode: primary
//   permission:
//     edit: allow
//     bash: allow
//     webfetch: allow
//   ---
//
// Every checked-in agent uses that block form. The inline flow-map spelling
// (`permission: { edit: allow }`) is also accepted, because this header used to
// show it while the parser dropped it.
//
//   <body, referencing percussionist_dispatcher_* tools>
//
// Claude Code wants `.claude/agents/<name>.md` with `name` + `description`
// frontmatter, keys its permissions off settings.json rather than the agent
// file, and exposes MCP tools as `mcp__<server>__<tool>` — so `mode`,
// `permission` and the body's tool names all need handling.

import type { AgentDef } from '@percussionist/api';

/** Frontmatter fields we understand; everything else is dropped deliberately. */
export type OpencodeAgent = {
  name?: string;
  description?: string;
  /** opencode's `primary` means "this is the main agent", not a subagent. */
  mode?: string;
  /** Per-tool allow/deny/ask map, keyed by opencode's lowercase tool names. */
  permission: Record<string, string>;
  body: string;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Minimal frontmatter reader for the shapes ClusterAgent content actually uses:
 * `key: value` scalars plus a one-level nested `permission:` map. Deliberately
 * not a YAML parser — pulling one in for two known shapes is not worth the
 * dependency, and unknown keys are dropped rather than mistranslated.
 */
/**
 * Read a YAML inline flow map — `{ edit: allow, bash: allow }` — into a plain
 * record. Returns undefined when the value is not that shape, which is the
 * signal to fall through to the indented block form.
 *
 * Deliberately shallow: the permission map is one level of string-to-string, so
 * a value containing a nested brace is not this shape and is refused rather
 * than guessed at.
 */
function parseInlinePermission(value: string): Record<string, string> | undefined {
  if (!value.startsWith('{') || !value.endsWith('}')) return undefined;
  const inner = value.slice(1, -1).trim();
  if (inner === '') return {};
  if (inner.includes('{') || inner.includes('}')) return undefined;

  const out: Record<string, string> = {};
  for (const entry of inner.split(',')) {
    const idx = entry.indexOf(':');
    if (idx === -1) continue;
    const k = entry.slice(0, idx).trim();
    const v = entry.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

export function parseOpencodeAgent(content: string): OpencodeAgent {
  const match = FRONTMATTER.exec(content);
  if (!match) return { permission: {}, body: content.trim() };

  const [full, block] = match;
  const body = content.slice(full.length).trim();
  const agent: OpencodeAgent = { permission: {}, body };

  let inPermission = false;
  for (const raw of (block ?? '').split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const indented = /^\s/.test(raw);
    const line = raw.trim();

    if (inPermission && indented) {
      const [k, ...rest] = line.split(':');
      if (k && rest.length > 0) agent.permission[k.trim()] = rest.join(':').trim();
      continue;
    }
    inPermission = false;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (key === 'permission') {
      // Both YAML spellings occur. The block form puts each entry on its own
      // indented line and is handled by the branch above; the inline flow-map
      // form puts them all here. Dropping the inline value used to yield an
      // empty permission map, and since every denial lives in that map the
      // resulting settings.json was `{}` — every restriction silently lost,
      // which is the wrong direction to fail in.
      const inline = parseInlinePermission(value);
      if (inline) Object.assign(agent.permission, inline);
      else inPermission = true;
      continue;
    }
    if (key === 'name') agent.name = value;
    else if (key === 'description') agent.description = value;
    else if (key === 'mode') agent.mode = value;
  }

  return agent;
}

/**
 * opencode addresses the dispatcher's MCP tools as `percussionist_dispatcher_x`;
 * Claude Code addresses the same tools as `mcp__dispatcher__x` (server key set
 * in runner-claude's session config). Agent bodies name these tools explicitly
 * — builder.yaml's completion section is nothing but such a reference — so
 * leaving them alone tells the model to call tools that do not exist.
 *
 * This rewrites the bare prefix rather than prefix-plus-tool-name, because agent
 * bodies also discuss the prefix in prose ("tools with the
 * `percussionist_dispatcher_*` prefix", "call with percussionist_dispatcher_
 * prefix"). Matching only a following tool name leaves those untouched and the
 * result actively contradicts its own tool list.
 */
export function rewriteDispatcherToolNames(body: string): string {
  return body.replaceAll('percussionist_dispatcher_', 'mcp__dispatcher__');
}

/** True when opencode would treat this as the session's main agent. */
export function isPrimaryAgent(agent: OpencodeAgent): boolean {
  return agent.mode === 'primary';
}

/**
 * Render a Claude Code subagent file.
 *
 * Note there is deliberately no `tools:` key. Claude Code treats that field as
 * an allowlist, and the opencode `permission` map never mentions MCP tools — so
 * deriving `tools:` from it would strip `mcp__dispatcher__complete_run` and
 * leave the agent unable to signal completion, failing every run it is used
 * for. Restrictions belong in settings.json (see renderClaudeSettings).
 */
export function renderClaudeAgentFile(def: AgentDef): string {
  const agent = parseOpencodeAgent(def.content);
  const name = agent.name ?? def.name;
  const lines = ['---', `name: ${name}`];
  if (agent.description) lines.push(`description: ${agent.description}`);
  lines.push('---', '', rewriteDispatcherToolNames(agent.body), '');
  return lines.join('\n');
}

/**
 * opencode tool name → the Claude Code tool(s) it corresponds to.
 *
 * `edit` covers both editing and creating files in opencode, so it maps to two
 * tools. `list` has no Claude Code equivalent — directory listing goes through
 * Glob and Bash — so it is intentionally absent rather than guessed at.
 */
const TOOL_EQUIVALENTS: Record<string, string[]> = {
  edit: ['Edit', 'Write'],
  write: ['Write'],
  patch: ['Edit'],
  bash: ['Bash'],
  read: ['Read'],
  glob: ['Glob'],
  grep: ['Grep'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  todowrite: ['TodoWrite'],
  task: ['Task'],
};

/**
 * Pick the agent whose permissions settings.json should express.
 *
 * `primaryName` is `Run.spec.agent` — the agent that actually drives the
 * session. When it is unset or names something not mounted, one mounted agent
 * is still unambiguous; anything else is a guess, and guessing is what caused
 * the bug this function exists to prevent (see renderClaudeSettings).
 */
function settingsSourceAgent(
  agents: AgentDef[],
  primaryName: string | undefined,
): AgentDef | undefined {
  const named = primaryName ? agents.find((a) => a.name === primaryName) : undefined;
  if (named) return named;
  return agents.length === 1 ? agents[0] : undefined;
}

/**
 * Build `.claude/settings.json` for a run.
 *
 * Only denials are translated. An opencode `allow` needs no counterpart because
 * the runner already runs in bypassPermissions mode inside a capability-dropped
 * pod, whereas a `deny` expresses real intent that would otherwise be lost. An
 * `ask` is treated as a deny: nothing in a run pod can answer a prompt, so
 * "ask" can only ever mean "do not proceed".
 *
 * Denials come from the *primary* agent alone. Claude Code reads one
 * settings.json per pod, so unioning the mounted set applied every agent's
 * restrictions to all of them: a planner run mounting `reviewer` alongside
 * itself inherited that agent's `edit: deny` and lost Write and Edit, despite
 * its own frontmatter allowing them. Observed directly — the planner announced
 * "No `Write` tool is available in this run" and wrote a 23KB plan through a
 * bash heredoc instead.
 *
 * The cost is that a subagent invoked via the Task tool runs under the primary
 * agent's permissions rather than its own. That is a real gap, but it is the
 * narrower one: Claude Code has no per-subagent permission file, and the only
 * alternative — a `tools:` allowlist in each subagent .md — is an allowlist, so
 * it would strip `mcp__dispatcher__*` and leave subagents unable to signal
 * completion (see renderClaudeAgentFile). Restricting the agent in the loop
 * beats disarming it.
 */
export function renderClaudeSettings(agents: AgentDef[], primaryName: string | undefined): string {
  const deny = new Set<string>();
  const source = settingsSourceAgent(agents, primaryName);
  if (source) {
    const { permission } = parseOpencodeAgent(source.content);
    for (const [tool, decision] of Object.entries(permission)) {
      if (decision === 'allow') continue;
      for (const mapped of TOOL_EQUIVALENTS[tool] ?? []) deny.add(mapped);
    }
  }
  const settings = deny.size > 0 ? { permissions: { deny: [...deny].sort() } } : {};
  return JSON.stringify(settings, null, 2);
}

/**
 * The system prompt for the run's main agent.
 *
 * A `mode: primary` opencode agent describes how the *session itself* should
 * behave, which has no equivalent in a subagent file — Claude Code would only
 * consult that file if something invoked it via the Task tool. Returning the
 * body here lets pod-builder pass it as CLAUDE_APPEND_SYSTEM_PROMPT, which
 * runner-claude appends to Claude Code's own system prompt.
 */
export function primaryAgentSystemPrompt(
  agents: AgentDef[],
  primaryName: string | undefined,
): string | undefined {
  if (!primaryName) return undefined;
  const def = agents.find((a) => a.name === primaryName);
  if (!def) return undefined;
  const agent = parseOpencodeAgent(def.content);
  const body = rewriteDispatcherToolNames(agent.body);
  return body.length > 0 ? body : undefined;
}

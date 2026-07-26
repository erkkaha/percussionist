import { describe, expect, test } from 'bun:test';
import type { AgentDef } from '@percussionist/api';
import {
  isPrimaryAgent,
  parseOpencodeAgent,
  primaryAgentSystemPrompt,
  renderClaudeAgentFile,
  renderClaudeSettings,
  rewriteDispatcherToolNames,
} from './claude-config.js';

/** Shaped like the real k8s/agents/builder.yaml content. */
const BUILDER: AgentDef = {
  name: 'builder',
  content: `---
name: builder
description: Builder agent — implements a BUILD task, commits the work
mode: primary
permission:
  edit: allow
  bash: allow
  read: allow
  webfetch: allow
  todowrite: allow
---
You are a builder agent.

## Completion

When done, call \`percussionist_dispatcher_complete_run\` with a summary.
`,
};

describe('parseOpencodeAgent', () => {
  test('reads scalars and the nested permission map', () => {
    const a = parseOpencodeAgent(BUILDER.content);
    expect(a.name).toBe('builder');
    expect(a.mode).toBe('primary');
    expect(a.description).toContain('Builder agent');
    expect(a.permission).toEqual({
      edit: 'allow',
      bash: 'allow',
      read: 'allow',
      webfetch: 'allow',
      todowrite: 'allow',
    });
  });

  test('body excludes the frontmatter', () => {
    const a = parseOpencodeAgent(BUILDER.content);
    expect(a.body.startsWith('You are a builder agent.')).toBe(true);
    expect(a.body).not.toContain('mode: primary');
  });

  test('content with no frontmatter is treated as all body', () => {
    const a = parseOpencodeAgent('just a prompt');
    expect(a.body).toBe('just a prompt');
    expect(a.name).toBeUndefined();
    expect(a.permission).toEqual({});
  });

  test('a description containing a colon is not truncated', () => {
    const a = parseOpencodeAgent('---\nname: x\ndescription: does a thing: carefully\n---\nbody');
    expect(a.description).toBe('does a thing: carefully');
  });

  test('keys after the permission block are not swallowed by it', () => {
    const a = parseOpencodeAgent(
      '---\npermission:\n  bash: allow\nmode: subagent\nname: n\n---\nbody',
    );
    expect(a.permission).toEqual({ bash: 'allow' });
    expect(a.mode).toBe('subagent');
    expect(a.name).toBe('n');
  });
});

// Agent bodies name the dispatcher's MCP tools explicitly. opencode calls them
// percussionist_dispatcher_*; Claude Code calls the same tools mcp__dispatcher__*.
// Left alone, the prompt instructs the model to call a tool that does not exist.
describe('rewriteDispatcherToolNames', () => {
  test('rewrites the dispatcher prefix to the MCP naming scheme', () => {
    expect(rewriteDispatcherToolNames('call percussionist_dispatcher_complete_run now')).toBe(
      'call mcp__dispatcher__complete_run now',
    );
  });

  test('rewrites every occurrence', () => {
    const out = rewriteDispatcherToolNames(
      'percussionist_dispatcher_fail_run and percussionist_dispatcher_get_status',
    );
    expect(out).toBe('mcp__dispatcher__fail_run and mcp__dispatcher__get_status');
  });

  test('leaves unrelated text untouched', () => {
    expect(rewriteDispatcherToolNames('the dispatcher sidecar')).toBe('the dispatcher sidecar');
  });

  // builder.yaml discusses the prefix in prose as well as naming tools. Matching
  // only prefix+toolname leaves these behind, and the agent file then contradicts
  // its own (correctly rewritten) tool list.
  test('rewrites a glob-style prefix mention', () => {
    expect(rewriteDispatcherToolNames('tools with the `percussionist_dispatcher_*` prefix')).toBe(
      'tools with the `mcp__dispatcher__*` prefix',
    );
  });

  test('rewrites a bare trailing prefix mention', () => {
    expect(rewriteDispatcherToolNames('call with percussionist_dispatcher_ prefix')).toBe(
      'call with mcp__dispatcher__ prefix',
    );
  });

  test('no percussionist_dispatcher_ reference survives a real agent body', () => {
    expect(renderClaudeAgentFile(BUILDER)).not.toContain('percussionist_dispatcher_');
  });
});

describe('renderClaudeAgentFile', () => {
  test('emits Claude Code frontmatter', () => {
    const out = renderClaudeAgentFile(BUILDER);
    expect(out.startsWith('---\nname: builder\n')).toBe(true);
    expect(out).toContain('description: Builder agent');
  });

  test('drops opencode-only frontmatter keys', () => {
    const out = renderClaudeAgentFile(BUILDER);
    expect(out).not.toContain('mode:');
    expect(out).not.toContain('permission:');
  });

  // Claude Code treats `tools:` as an allowlist, and the opencode permission map
  // never mentions MCP tools — deriving it would strip
  // mcp__dispatcher__complete_run and make the run unable to signal completion.
  test('does not emit a tools allowlist', () => {
    expect(renderClaudeAgentFile(BUILDER)).not.toContain('tools:');
  });

  test('rewrites dispatcher tool names in the body', () => {
    const out = renderClaudeAgentFile(BUILDER);
    expect(out).toContain('mcp__dispatcher__complete_run');
    expect(out).not.toContain('percussionist_dispatcher_');
  });

  test('falls back to the AgentDef name when frontmatter omits it', () => {
    const out = renderClaudeAgentFile({ name: 'fallback', content: 'no frontmatter here' });
    expect(out).toContain('name: fallback');
  });
});

describe('renderClaudeSettings', () => {
  test('an all-allow agent produces no restrictions', () => {
    expect(renderClaudeSettings([BUILDER])).toBe('{}');
  });

  test('a denied tool becomes a deny rule under its Claude Code name', () => {
    const denied: AgentDef = {
      name: 'reader',
      content: '---\nname: reader\npermission:\n  bash: deny\n  read: allow\n---\nbody',
    };
    expect(JSON.parse(renderClaudeSettings([denied]))).toEqual({
      permissions: { deny: ['Bash'] },
    });
  });

  // Nothing in a run pod can answer a prompt, so "ask" can only mean "do not".
  test('ask is treated as deny', () => {
    const asked: AgentDef = {
      name: 'a',
      content: '---\nname: a\npermission:\n  webfetch: ask\n---\nbody',
    };
    expect(JSON.parse(renderClaudeSettings([asked]))).toEqual({
      permissions: { deny: ['WebFetch'] },
    });
  });

  test('opencode edit maps to both Edit and Write', () => {
    const denied: AgentDef = {
      name: 'a',
      content: '---\nname: a\npermission:\n  edit: deny\n---\nbody',
    };
    expect(JSON.parse(renderClaudeSettings([denied])).permissions.deny).toEqual(['Edit', 'Write']);
  });

  test('denials union across agents and stay deduplicated', () => {
    const a: AgentDef = { name: 'a', content: '---\npermission:\n  bash: deny\n---\nb' };
    const b: AgentDef = {
      name: 'b',
      content: '---\npermission:\n  bash: deny\n  read: deny\n---\nb',
    };
    expect(JSON.parse(renderClaudeSettings([a, b])).permissions.deny).toEqual(['Bash', 'Read']);
  });

  // `list` has no Claude Code counterpart; guessing at one would deny a tool the
  // author never named.
  test('an unmapped opencode tool is ignored rather than guessed', () => {
    const denied: AgentDef = {
      name: 'a',
      content: '---\npermission:\n  list: deny\n---\nbody',
    };
    expect(renderClaudeSettings([denied])).toBe('{}');
  });
});

describe('primaryAgentSystemPrompt', () => {
  test('returns the named agent body with tool names rewritten', () => {
    const prompt = primaryAgentSystemPrompt([BUILDER], 'builder');
    expect(prompt).toContain('You are a builder agent.');
    expect(prompt).toContain('mcp__dispatcher__complete_run');
  });

  test('carries no frontmatter through', () => {
    expect(primaryAgentSystemPrompt([BUILDER], 'builder')).not.toContain('mode: primary');
  });

  test('undefined when no primary agent is named', () => {
    expect(primaryAgentSystemPrompt([BUILDER], undefined)).toBeUndefined();
  });

  test('undefined when the named agent is not among the resolved agents', () => {
    expect(primaryAgentSystemPrompt([BUILDER], 'nonexistent')).toBeUndefined();
  });
});

describe('isPrimaryAgent', () => {
  test('true only for mode: primary', () => {
    expect(isPrimaryAgent(parseOpencodeAgent(BUILDER.content))).toBe(true);
    expect(isPrimaryAgent(parseOpencodeAgent('---\nmode: subagent\n---\nb'))).toBe(false);
    expect(isPrimaryAgent(parseOpencodeAgent('no frontmatter'))).toBe(false);
  });
});

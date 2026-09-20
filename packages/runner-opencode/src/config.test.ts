import { describe, expect, test } from 'bun:test';
import {
  agentConfigEntry,
  apiCredentials,
  buildConfigContent,
  envCredentials,
  parseAgentFile,
} from './config.js';

const BUILDER = `---
name: builder
description: Builder agent — implements a BUILD task, commits the work
mode: primary
temperature: 0.2
permission:
  edit: allow
  bash: allow
  webfetch: allow
---
You are a builder agent.

Implement the task.
`;

describe('parseAgentFile', () => {
  test('reads frontmatter scalars, nested permission map and body', () => {
    const p = parseAgentFile(BUILDER);
    expect(p.name).toBe('builder');
    expect(p.fields.mode).toBe('primary');
    expect(p.fields.temperature).toBe(0.2);
    expect(p.fields.permission).toEqual({ edit: 'allow', bash: 'allow', webfetch: 'allow' });
    expect(p.body).toBe('You are a builder agent.\n\nImplement the task.');
  });

  test('inline flow-map permission is accepted', () => {
    const p = parseAgentFile('---\nname: r\npermission: { edit: deny, bash: allow }\n---\nBody');
    expect(p.fields.permission).toEqual({ edit: 'deny', bash: 'allow' });
  });

  test('no frontmatter yields a prompt-only agent', () => {
    expect(parseAgentFile('Just a prompt')).toEqual({
      name: undefined,
      body: 'Just a prompt',
      fields: {},
    });
  });

  test('unparseable frontmatter keeps the prompt', () => {
    const p = parseAgentFile('---\nname: [oops\n---\nPrompt');
    expect(p.body).toBe('Prompt');
    expect(p.fields).toEqual({});
  });
});

describe('agentConfigEntry', () => {
  test('copies known keys and maps body to prompt, drops name and unknowns', () => {
    const p = parseAgentFile(`---\nname: x\nmode: subagent\nfoo: bar\ndescription: d\n---\nP`);
    expect(agentConfigEntry(p)).toEqual({ description: 'd', mode: 'subagent', prompt: 'P' });
  });
});

describe('buildConfigContent', () => {
  const cluster = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      'llama.cpp': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://x/v1', apiKey: 'k1' },
      },
    },
    mcp: {
      'percussionist-dispatcher': {
        type: 'remote',
        url: 'http://127.0.0.1:4097/mcp',
        enabled: true,
      },
    },
  });
  const auth = JSON.stringify({
    'github-copilot': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    'opencode-go': { type: 'api', key: 'sk-go' },
  });

  test('leaves provider settings alone and classifies credentials', () => {
    const r = buildConfigContent({ configContent: cluster, authContent: auth });
    const cfg = JSON.parse(r.content);
    expect(cfg.provider['opencode-go']).toBeUndefined();
    expect(cfg.provider['llama.cpp'].options.apiKey).toBe('k1');
    expect(r.notes.some((n) => n.includes('opencode-go api key will be registered'))).toBe(true);
    // github-copilot is an env-method credential, not an unsupported one.
    expect(r.warnings).toEqual([]);
    expect(r.notes.some((n) => n.includes('github-copilot') && n.includes('GITHUB_TOKEN'))).toBe(
      true,
    );
  });

  test('keeps an existing dispatcher MCP entry and adds one when missing', () => {
    const kept = JSON.parse(
      buildConfigContent({ configContent: cluster, dispatcherMcpUrl: 'http://127.0.0.1:4097/mcp' })
        .content,
    );
    expect(Object.keys(kept.mcp)).toEqual(['percussionist-dispatcher']);

    const added = JSON.parse(
      buildConfigContent({ dispatcherMcpUrl: 'http://127.0.0.1:4097/mcp' }).content,
    );
    expect(added.mcp['percussionist-dispatcher']).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:4097/mcp',
      enabled: true,
    });
  });

  test('inlines mounted agent files under the legacy agent key', () => {
    const r = buildConfigContent({
      agentFiles: [
        { name: 'builder', content: BUILDER },
        { name: 'reviewer', content: '---\ndescription: R\nmode: subagent\n---\nReview.' },
      ],
    });
    const cfg = JSON.parse(r.content);
    expect(Object.keys(cfg.agent).sort()).toEqual(['builder', 'reviewer']);
    expect(cfg.agent.builder).toEqual({
      description: 'Builder agent — implements a BUILD task, commits the work',
      mode: 'primary',
      temperature: 0.2,
      permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
      prompt: 'You are a builder agent.\n\nImplement the task.',
    });
    expect(cfg.agent.reviewer).toEqual({ description: 'R', mode: 'subagent', prompt: 'Review.' });
  });

  test('a file name is the fallback agent name; config-defined agents win', () => {
    const r = buildConfigContent({
      configContent: JSON.stringify({ agent: { builder: { prompt: 'from config' } } }),
      agentFiles: [
        { name: 'builder', content: 'from file' },
        { name: 'extra', content: 'E' },
      ],
    });
    const cfg = JSON.parse(r.content);
    expect(cfg.agent.builder).toEqual({ prompt: 'from config' });
    expect(cfg.agent.extra).toEqual({ prompt: 'E' });
  });

  test('invalid JSON inputs are reported, not thrown', () => {
    const r = buildConfigContent({ configContent: '{nope', authContent: 'x' });
    expect(r.content).toBe('{}');
    expect(r.warnings).toHaveLength(2);
  });
});

describe('apiCredentials', () => {
  test('returns api entries only, skipping oauth and malformed input', () => {
    const auth = JSON.stringify({
      'github-copilot': { type: 'oauth', access: 'a' },
      'opencode-go': { type: 'api', key: 'sk-go' },
      empty: { type: 'api', key: '' },
    });
    expect(apiCredentials(auth)).toEqual([{ providerID: 'opencode-go', key: 'sk-go' }]);
    expect(apiCredentials('{oops')).toEqual([]);
    expect(apiCredentials(undefined)).toEqual([]);
  });
});

describe('envCredentials', () => {
  test('maps the github-copilot oauth token to GITHUB_TOKEN, preferring refresh', () => {
    const auth = JSON.stringify({
      'github-copilot': { type: 'oauth', access: 'gho_a', refresh: 'gho_r', expires: 0 },
      'opencode-go': { type: 'api', key: 'sk' },
      other: { type: 'oauth', access: 'x' },
    });
    expect(envCredentials(auth)).toEqual([
      { providerID: 'github-copilot', env: 'GITHUB_TOKEN', value: 'gho_r' },
    ]);
    expect(
      envCredentials(JSON.stringify({ 'github-copilot': { type: 'oauth', access: 'gho_a' } })),
    ).toEqual([{ providerID: 'github-copilot', env: 'GITHUB_TOKEN', value: 'gho_a' }]);
    expect(envCredentials(undefined)).toEqual([]);
  });

  test('buildConfigContent notes the env mapping instead of warning', () => {
    const r = buildConfigContent({
      authContent: JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: 'gho_r' } }),
    });
    expect(r.warnings).toEqual([]);
    expect(r.notes.some((n) => n.includes('GITHUB_TOKEN'))).toBe(true);
  });
});

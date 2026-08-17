// findings-tools.test.ts — schema verification for list_findings, update_finding,
// create_task_from_finding MCP tools.
//
// Asserts against the actual inputSchema JSON served by tools/list — a real tool
// definition can fail these (unlike the old source-string substring checks).

import { describe, expect, it } from 'bun:test';

const { __test } = await import('../tools.js');

type ToolEntry = {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
};

async function listTools(): Promise<ToolEntry[]> {
  const res = (await __test.handleMcp({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })) as { result?: { tools?: ToolEntry[] } };
  return res.result?.tools ?? [];
}

async function schemaOf(name: string): Promise<{
  required: string[];
  properties: Record<string, unknown>;
}> {
  const tools = await listTools();
  const tool = tools.find((t) => t.name === name);
  expect(tool, `tool "${name}" is registered in the TOOLS array`).toBeDefined();
  return {
    required: tool?.inputSchema?.required ?? [],
    properties: tool?.inputSchema?.properties ?? {},
  };
}

describe('list_findings tool schema', () => {
  it('is registered in the TOOLS array', async () => {
    expect((await listTools()).some((t) => t.name === 'list_findings')).toBe(true);
  });

  it('requires the project arg', async () => {
    const { required } = await schemaOf('list_findings');
    expect(required).toContain('project');
  });

  it('declares status, severity, category, limit as optional filters', async () => {
    const { required, properties } = await schemaOf('list_findings');
    for (const key of ['status', 'severity', 'category', 'limit']) {
      expect(properties, `property "${key}"`).toHaveProperty(key);
      expect(required).not.toContain(key);
    }
  });
});

describe('update_finding tool schema', () => {
  it('is registered in the TOOLS array', async () => {
    expect((await listTools()).some((t) => t.name === 'update_finding')).toBe(true);
  });

  it('requires project and id args', async () => {
    const { required } = await schemaOf('update_finding');
    expect(required).toEqual(expect.arrayContaining(['project', 'id']));
  });

  it('declares status, severity, category as optional update fields', async () => {
    const { required, properties } = await schemaOf('update_finding');
    for (const key of ['status', 'severity', 'category']) {
      expect(properties, `property "${key}"`).toHaveProperty(key);
      expect(required).not.toContain(key);
    }
  });
});

describe('create_task_from_finding tool schema', () => {
  it('is registered in the TOOLS array', async () => {
    expect((await listTools()).some((t) => t.name === 'create_task_from_finding')).toBe(true);
  });

  it('requires project and id args', async () => {
    const { required } = await schemaOf('create_task_from_finding');
    expect(required).toEqual(expect.arrayContaining(['project', 'id']));
  });

  it('declares agent and priority as optional args', async () => {
    const { required, properties } = await schemaOf('create_task_from_finding');
    for (const key of ['agent', 'priority']) {
      expect(properties, `property "${key}"`).toHaveProperty(key);
      expect(required).not.toContain(key);
    }
  });
});

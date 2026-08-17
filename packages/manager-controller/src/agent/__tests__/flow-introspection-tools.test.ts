// flow-introspection-tools.test.ts — verify the inspect_task_flow MCP tool
// schema against the actual inputSchema JSON served by tools/list.

import { describe, expect, it } from 'bun:test';

const { __test } = await import('../tools.js');

type ToolEntry = {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
};

describe('inspect_task_flow tool wiring', () => {
  async function schemaOf(): Promise<{ required: string[]; properties: Record<string, unknown> }> {
    const res = (await __test.handleMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })) as { result?: { tools?: ToolEntry[] } };
    const tool = res.result?.tools?.find((t) => t.name === 'inspect_task_flow');
    expect(tool, 'inspect_task_flow is registered in the TOOLS array').toBeDefined();
    return {
      required: tool?.inputSchema?.required ?? [],
      properties: tool?.inputSchema?.properties ?? {},
    };
  }

  it('registers inspect_task_flow in the TOOLS array', async () => {
    const { required } = await schemaOf();
    expect(required).toBeDefined();
  });

  it('requires project and task', async () => {
    const { required } = await schemaOf();
    expect(required).toEqual(expect.arrayContaining(['project', 'task']));
  });

  it('accepts optional namespace and verbose parameters', async () => {
    const { required, properties } = await schemaOf();
    for (const key of ['namespace', 'verbose']) {
      expect(properties, `property "${key}"`).toHaveProperty(key);
      expect(required).not.toContain(key);
    }
  });
});

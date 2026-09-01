// memory-tools.test.ts — unit tests for manager controller memory MCP tools.
//
// Tests cover:
// 1. Tool schema definitions (asserted against the actual inputSchema JSON
//    served by tools/list — the old tests read tools.ts as a string and only
//    checked that substrings like 'project' appeared somewhere)
// 2. Memory client CRUD methods with mocked fetch

import { describe, expect, it } from 'bun:test';

const { __test } = await import('../tools.js');

// ---------------------------------------------------------------------------
// Tool schema definitions — assert against the real TOOLS array.
// ---------------------------------------------------------------------------

type ToolEntry = {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
};

describe('memory tool schema definitions', () => {
  async function loadTools(): Promise<ToolEntry[]> {
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
    const tool = (await loadTools()).find((t) => t.name === name);
    expect(tool, `tool "${name}" is registered in the TOOLS array`).toBeDefined();
    return {
      required: tool?.inputSchema?.required ?? [],
      properties: tool?.inputSchema?.properties ?? {},
    };
  }

  it('registers all 7 memory tools in the TOOLS array', async () => {
    const tools = await loadTools();
    for (const name of [
      'store_memory',
      'query_memory',
      'get_context',
      'list_memories',
      'get_memory',
      'update_memory',
      'delete_memory',
    ]) {
      expect(
        tools.some((t) => t.name === name),
        `tool "${name}"`,
      ).toBe(true);
    }
  });

  it('list_memories requires project and declares task, limit, offset as optional', async () => {
    const { required, properties } = await schemaOf('list_memories');
    expect(required).toEqual(['project']);
    for (const key of ['task', 'limit', 'offset']) {
      expect(properties, `property "${key}"`).toHaveProperty(key);
    }
  });

  it('get_memory requires project and id', async () => {
    const { required, properties } = await schemaOf('get_memory');
    expect(required).toEqual(expect.arrayContaining(['project', 'id']));
    expect(properties).toHaveProperty('id');
  });

  it('update_memory requires project and id, declares content and metadata optional', async () => {
    const { required, properties } = await schemaOf('update_memory');
    expect(required).toEqual(expect.arrayContaining(['project', 'id']));
    for (const key of ['content', 'metadata']) {
      expect(properties, `property "${key}"`).toHaveProperty(key);
      expect(required).not.toContain(key);
    }
  });

  it('delete_memory requires project and id', async () => {
    const { required, properties } = await schemaOf('delete_memory');
    expect(required).toEqual(expect.arrayContaining(['project', 'id']));
    expect(properties).toHaveProperty('id');
  });

  it('store_memory requires project and content', async () => {
    const { required, properties } = await schemaOf('store_memory');
    expect(required).toEqual(expect.arrayContaining(['project', 'content']));
    expect(properties).toHaveProperty('content');
  });

  it('query_memory requires project and query', async () => {
    const { required } = await schemaOf('query_memory');
    expect(required).toEqual(expect.arrayContaining(['project', 'query']));
  });

  it('get_context requires project and query', async () => {
    const { required } = await schemaOf('get_context');
    expect(required).toEqual(expect.arrayContaining(['project', 'query']));
  });
});

// ---------------------------------------------------------------------------
// Memory client CRUD methods — mock fetch to test HTTP interactions.
// ---------------------------------------------------------------------------

describe('listMemories', () => {
  it('should call GET /memories with correct URL and query params', async () => {
    const mockResponse = {
      memories: [
        {
          id: 'm1',
          content: 'test',
          metadata: null,
          distance: 0,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      total: 1,
    };

    globalThis.fetch = async (url: string) => {
      const u = new URL(url);
      expect(u.pathname).toBe('/memories');
      expect(u.searchParams.get('task')).toBe('BUILD-42');
      expect(u.searchParams.get('limit')).toBe('100');
      expect(u.searchParams.get('offset')).toBe('20');
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { listMemories } = await import('../memory-client.js');
    const result = await listMemories('test-project', {
      task: 'BUILD-42',
      limit: 100,
      offset: 20,
    });

    expect(result).toEqual(mockResponse);
  });

  it('should call GET /memories without optional params when omitted', async () => {
    const mockResponse = { memories: [], total: 0 };

    globalThis.fetch = async (url: string) => {
      const u = new URL(url);
      expect(u.pathname).toBe('/memories');
      expect(u.searchParams.has('task')).toBe(false);
      expect(u.searchParams.has('limit')).toBe(false);
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { listMemories } = await import('../memory-client.js');
    const result = await listMemories('test-project');
    expect(result).toEqual(mockResponse);
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = async () => new Response('not found', { status: 404 });

    const { listMemories } = await import('../memory-client.js');
    await expect(listMemories('test-project')).rejects.toThrow(
      'memory service (test-project) list failed (404)',
    );
  });
});

describe('getMemory', () => {
  it('should call GET /memory/:id with correct URL', async () => {
    const mockResponse = {
      id: 'abc-123',
      content: 'test memory',
      metadata: { task: 'BUILD-42' },
      distance: 0,
      createdAt: '2025-01-01T00:00:00Z',
    };

    globalThis.fetch = async (url: string) => {
      expect(url).toContain('/memory/abc-123');
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { getMemory } = await import('../memory-client.js');
    const result = await getMemory('test-project', 'abc-123');
    expect(result).toEqual(mockResponse);
  });

  it('should URL-encode memory IDs with special characters', async () => {
    globalThis.fetch = async (url: string) => {
      expect(url).toContain('/memory/abc%20123');
      return new Response(
        JSON.stringify({
          id: 'abc 123',
          content: '',
          metadata: null,
          distance: 0,
          createdAt: null,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const { getMemory } = await import('../memory-client.js');
    await getMemory('test-project', 'abc 123');
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = async () => new Response('not found', { status: 404 });

    const { getMemory } = await import('../memory-client.js');
    await expect(getMemory('test-project', 'nonexistent')).rejects.toThrow(
      'memory service (test-project) get failed (404)',
    );
  });
});

describe('updateMemory', () => {
  it('should call PATCH /memory/:id with correct body', async () => {
    const mockResponse = {
      id: 'abc-123',
      content: 'updated content',
      metadata: { task: 'BUILD-42' },
      distance: 0,
      createdAt: '2025-01-01T00:00:00Z',
    };

    let capturedBody: unknown;
    globalThis.fetch = async (url: string, init?: any) => {
      expect(url).toContain('/memory/abc-123');
      expect(init?.method).toBe('PATCH');
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { updateMemory } = await import('../memory-client.js');
    const result = await updateMemory('test-project', 'abc-123', {
      content: 'updated content',
      metadata: { task: 'BUILD-42' },
    });

    expect(result).toEqual(mockResponse);
    expect(capturedBody).toEqual({
      content: 'updated content',
      metadata: { task: 'BUILD-42' },
    });
  });

  it('should send only provided fields for partial update', async () => {
    const mockResponse = {
      id: 'abc-123',
      content: 'original content',
      metadata: { updated: true },
      distance: 0,
      createdAt: '2025-01-01T00:00:00Z',
    };

    let capturedBody: unknown;
    globalThis.fetch = async (_url: string, init?: any) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { updateMemory } = await import('../memory-client.js');
    await updateMemory('test-project', 'abc-123', {
      metadata: { updated: true },
    });

    // Only metadata should be in the body; content is undefined and omitted.
    expect(capturedBody).toEqual({ metadata: { updated: true } });
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = async () => new Response('not found', { status: 404 });

    const { updateMemory } = await import('../memory-client.js');
    await expect(updateMemory('test-project', 'abc-123', { content: 'new' })).rejects.toThrow(
      'memory service (test-project) update failed (404)',
    );
  });
});

describe('deleteMemory', () => {
  it('should call DELETE /memory/:id with correct URL', async () => {
    let capturedMethod: string | undefined;
    globalThis.fetch = async (url: string, init?: any) => {
      expect(url).toContain('/memory/abc-123');
      capturedMethod = init?.method;
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { deleteMemory } = await import('../memory-client.js');
    const result = await deleteMemory('test-project', 'abc-123');
    expect(result).toEqual({ deleted: true });
    expect(capturedMethod).toBe('DELETE');
  });

  it('should URL-encode memory IDs with special characters', async () => {
    globalThis.fetch = async (url: string) => {
      expect(url).toContain('/memory/abc%20123');
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { deleteMemory } = await import('../memory-client.js');
    await deleteMemory('test-project', 'abc 123');
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = async () => new Response('not found', { status: 404 });

    const { deleteMemory } = await import('../memory-client.js');
    await expect(deleteMemory('test-project', 'nonexistent')).rejects.toThrow(
      'memory service (test-project) delete failed (404)',
    );
  });
});

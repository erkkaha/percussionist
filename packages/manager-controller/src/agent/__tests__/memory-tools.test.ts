// memory-tools.test.ts — unit tests for manager controller memory MCP tools.
//
// Tests cover:
// 1. Tool schema definitions (list_memories, get_memory, update_memory, delete_memory)
// 2. Memory client CRUD methods with mocked fetch

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import pathMod from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = pathMod.dirname(fileURLToPath(import.meta.url));
const toolsSource = fs.readFileSync(pathMod.join(__dirname, '../tools.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// Tool schema definitions — verify TOOLS array contains all expected memory tools.
// These tests read the source file to extract tool definitions without importing
// the full tools.ts module (which starts an HTTP server). This keeps tests fast
// and deterministic.

describe('memory tool schema definitions', () => {
  // Extract just the properties block for a given tool name by finding its
  // position in the source and scanning forward to the matching closing brace.
  function extractToolProperties(name: string): string | null {
    const nameIdx = toolsSource.indexOf(`name: '${name}'`);
    if (nameIdx < 0) return null;

    // Find the opening `{` of this tool object — it's before `name:`.
    let openBrace = -1;
    for (let i = nameIdx - 1; i >= Math.max(0, nameIdx - 200); i--) {
      if (toolsSource[i] === '{') {
        openBrace = i;
        break;
      }
    }
    if (openBrace < 0) return null;

    // Find the matching closing `}` by counting braces.
    let depth = 0;
    let closeBrace = -1;
    for (let i = openBrace; i < toolsSource.length; i++) {
      if (toolsSource[i] === '{') depth++;
      else if (toolsSource[i] === '}') {
        depth--;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }
    if (closeBrace < 0) return null;

    // Extract the full tool object block.
    const block = toolsSource.slice(openBrace, closeBrace + 1);

    // Now extract properties with proper brace matching.
    const propsStartIdx = block.indexOf('properties:');
    if (propsStartIdx < 0) return null;

    let depth2 = 0;
    let propsOpen = -1;
    for (let i = propsStartIdx; i < block.length; i++) {
      if (block[i] === '{') {
        if (depth2 === 0) {
          propsOpen = i;
        }
        depth2++;
      } else if (block[i] === '}') {
        depth2--;
        if (depth2 === 0 && propsOpen >= 0) {
          return block.slice(propsOpen + 1, i);
        }
      }
    }
    return null;
  }

  function extractToolRequired(name: string): string | null {
    const nameIdx = toolsSource.indexOf(`name: '${name}'`);
    if (nameIdx < 0) return null;

    let openBrace = -1;
    for (let i = nameIdx - 1; i >= Math.max(0, nameIdx - 200); i--) {
      if (toolsSource[i] === '{') {
        openBrace = i;
        break;
      }
    }
    if (openBrace < 0) return null;

    let depth = 0;
    let closeBrace = -1;
    for (let i = openBrace; i < toolsSource.length; i++) {
      if (toolsSource[i] === '{') depth++;
      else if (toolsSource[i] === '}') {
        depth--;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }
    if (closeBrace < 0) return null;

    const block = toolsSource.slice(openBrace, closeBrace + 1);
    // Find `required:` and extract the array content with proper bracket matching.
    const reqStartIdx = block.indexOf('required:');
    if (reqStartIdx < 0) return null;

    let bracketDepth = 0;
    let reqOpen = -1;
    for (let i = reqStartIdx; i < block.length; i++) {
      if (block[i] === '[') {
        if (bracketDepth === 0) {
          reqOpen = i;
        }
        bracketDepth++;
      } else if (block[i] === ']') {
        bracketDepth--;
        if (bracketDepth === 0 && reqOpen >= 0) {
          return block.slice(reqOpen + 1, i);
        }
      }
    }
    return null;
  }

  it('should define list_memories tool with project, task, limit, offset', () => {
    const props = extractToolProperties('list_memories');
    expect(props).not.toBeNull();
    expect(props!).toContain('task');
    expect(props!).toContain('limit');
    expect(props!).toContain('offset');

    const req = extractToolRequired('list_memories');
    expect(req).toBe("'project'");
  });

  it('should define get_memory tool with project and id', () => {
    const props = extractToolProperties('get_memory');
    expect(props).not.toBeNull();
    expect(props!).toContain('id');

    const req = extractToolRequired('get_memory');
    expect(req).toContain("'project'");
    expect(req).toContain("'id'");
  });

  it('should define update_memory tool with project, id, content, metadata', () => {
    const props = extractToolProperties('update_memory');
    expect(props).not.toBeNull();
    expect(props!).toContain('content');
    expect(props!).toContain('metadata');

    const req = extractToolRequired('update_memory');
    expect(req).toContain("'project'");
    expect(req).toContain("'id'");
  });

  it('should define delete_memory tool with project and id', () => {
    const props = extractToolProperties('delete_memory');
    expect(props).not.toBeNull();
    expect(props!).toContain('id');

    const req = extractToolRequired('delete_memory');
    expect(req).toContain("'project'");
    expect(req).toContain("'id'");
  });

  it('should preserve existing store_memory tool definition', () => {
    const props = extractToolProperties('store_memory');
    expect(props).not.toBeNull();
    expect(props!).toContain('content');

    const req = extractToolRequired('store_memory');
    expect(req).toContain("'project'");
    expect(req).toContain("'content'");
  });

  it('should preserve existing query_memory tool definition', () => {
    const props = extractToolProperties('query_memory');
    expect(props).not.toBeNull();
    expect(props!).toContain('query');

    const req = extractToolRequired('query_memory');
    expect(req).toContain("'project'");
    expect(req).toContain("'query'");
  });

  it('should preserve existing get_context tool definition', () => {
    const props = extractToolProperties('get_context');
    expect(props).not.toBeNull();
    expect(props!).toContain('query');

    const req = extractToolRequired('get_context');
    expect(req).toContain("'project'");
    expect(req).toContain("'query'");
  });

  it('should have all 7 memory tools in the TOOLS array', () => {
    const toolNames = [
      'store_memory',
      'query_memory',
      'get_context',
      'list_memories',
      'get_memory',
      'update_memory',
      'delete_memory',
    ];
    for (const name of toolNames) {
      expect(extractToolProperties(name)).not.toBeNull();
    }
  });

  it('should have callTool switch cases for all new memory tools', () => {
    const expectedCases = [
      "case 'list_memories'",
      "case 'get_memory'",
      "case 'update_memory'",
      "case 'delete_memory'",
    ];
    for (const caseStr of expectedCases) {
      expect(toolsSource).toContain(caseStr);
    }
  });

  it('should import all new memory client functions', () => {
    const imports = ['listMemories', 'getMemory', 'updateMemory', 'deleteMemory'];
    for (const fn of imports) {
      expect(toolsSource).toContain(fn);
    }
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

// ---------------------------------------------------------------------------
// Backward compatibility — ensure existing methods still work.
// ---------------------------------------------------------------------------

describe('backward compatibility with existing memory tools', () => {
  it('storeMemory should still call POST /memory', async () => {
    let capturedMethod: string | undefined;
    globalThis.fetch = async (url: string, init?: any) => {
      expect(url).toContain('/memory');
      capturedMethod = init?.method;
      return new Response(JSON.stringify({ id: 'new-id' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { storeMemory } = await import('../memory-client.js');
    const result = await storeMemory('test-project', 'hello world');
    expect(result).toEqual({ id: 'new-id' });
    expect(capturedMethod).toBe('POST');
  });

  it('queryMemory should still call POST /search', async () => {
    let capturedMethod: string | undefined;
    globalThis.fetch = async (url: string, init?: any) => {
      expect(url).toContain('/search');
      capturedMethod = init?.method;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { queryMemory } = await import('../memory-client.js');
    const result = await queryMemory('test-project', 'hello');
    expect(result).toEqual([]);
    expect(capturedMethod).toBe('POST');
  });

  it('getContext should still call POST /context', async () => {
    let capturedMethod: string | undefined;
    globalThis.fetch = async (url: string, init?: any) => {
      expect(url).toContain('/context');
      capturedMethod = init?.method;
      return new Response(JSON.stringify({ context: 'some context' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { getContext } = await import('../memory-client.js');
    const result = await getContext('test-project', 'hello');
    expect(result).toEqual({ context: 'some context' });
    expect(capturedMethod).toBe('POST');
  });
});

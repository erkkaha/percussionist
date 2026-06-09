// smoke.test.ts — integration smoke tests for the real Hono app.
//
// Uses app.request() (no port binding) against the full app built by
// createApp(). The K8s client and stats DB are both lazy — they only
// initialise on the first request that needs them.
//
// DATA_DIR is set to a temp directory before any request fires, so getDb()
// creates a fresh in-memory-equivalent DB for each test run.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";

// ---------------------------------------------------------------------------
// Test DB isolation — must be set before the first app.request() call that
// hits a DB-backed route, because getDb() is lazy.

const TEST_DATA_DIR = join("/tmp", `percussionist-smoke-${Date.now()}`);

process.env.DATA_DIR = TEST_DATA_DIR;

// Save and restore AUTH_DISABLED so auth.test.ts is not affected by this test.
const _prevAuthDisabled = process.env.AUTH_DISABLED;
process.env.AUTH_DISABLED = "1";

// ---------------------------------------------------------------------------

const app = createApp();

function req(path: string, init?: RequestInit) {
  return app.request(path, init);
}

function json(path: string, body: unknown, method = "POST") {
  return req(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  if (_prevAuthDisabled !== undefined) {
    process.env.AUTH_DISABLED = _prevAuthDisabled;
  } else {
    delete process.env.AUTH_DISABLED;
  }
});

// ===========================================================================
// Health check
// ===========================================================================

describe("health", () => {
  it("GET /api/health → 200", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });
});

// ===========================================================================
// Board API
// ===========================================================================
// Board state is backed by K8s Task CRs. Without a live cluster, CRUD
// operations return 5xx K8s errors. These tests verify routes are wired
// correctly (not 404) and that SQLite-backed event endpoints work.

const PROJECT = "smoke-test-proj";

describe("board routes", () => {
  // The board-overview route requires K8s, so it returns 500 (not 404).
  it("GET /api/projects/:project/board → 500 (K8s unavailable, not 404)", async () => {
    const res = await req(`/api/projects/${PROJECT}/board`);
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  it("POST /api/projects/:project/board/tasks missing fields → 400", async () => {
    const res = await json(`/api/projects/${PROJECT}/board/tasks`, {});
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  it("PATCH /api/projects/:project/board/spec invalid JSON → 400", async () => {
    const res = await req(`/api/projects/${PROJECT}/board/spec`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:project/board/tasks with valid type/title/agent → 500 (K8s)", async () => {
    const res = await json(`/api/projects/${PROJECT}/board/tasks`, {
      type: "BUILD",
      title: "test task",
      agent: "builder",
    });
    // Route is wired — returns 500 from K8s failure, not 404.
    expect([400, 500]).toContain(res.status);
  });

  it("POST /api/projects/:project/board/tasks/:taskName/move missing column → 400", async () => {
    const res = await json(`/api/projects/${PROJECT}/board/tasks/t1/move`, {});
    expect(res.status).toBe(400);
  });

  it("GET /api/board/:project/events → 200 with empty events list", async () => {
    const res = await req(`/api/board/${PROJECT}/events`);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("GET /api/board/:project/tasks/:taskName/events → 200 with empty events", async () => {
    const res = await req(`/api/board/${PROJECT}/tasks/t1/events`);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});

// ===========================================================================
// Stats API
// ===========================================================================

const SESSION_ID = `smoke-session-${Date.now()}`;

describe("stats API", () => {
  it("GET /api/stats/exists/:sessionID → false for unknown", async () => {
    const res = await req(`/api/stats/exists/no-such-session`);
    expect(res.status).toBe(200);
    const body = await res.json() as { exists: boolean };
    expect(body.exists).toBe(false);
  });

  it("POST /api/stats/session → 200 ok", async () => {
    const res = await json("/api/stats/session", {
      sessionID: SESSION_ID,
      run: {
        name: "smoke-run-1",
        namespace: "percussionist",
        task: "t1",
        model: "openai/gpt-4o",
        agent: "builder",
        phase: "Succeeded",
        startedAt: "2025-01-01T00:00:00Z",
        completedAt: "2025-01-01T00:05:00Z",
        tokensIn: 1000,
        tokensOut: 500,
      },
      messages: [
        {
          id: `${SESSION_ID}-0`,
          idx: 0,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "Hello" }]),
          tokensIn: 10,
          tokensOut: 0,
        },
        {
          id: `${SESSION_ID}-1`,
          idx: 1,
          role: "assistant",
          content: JSON.stringify([{ type: "text", text: "Done" }]),
          tokensIn: 0,
          tokensOut: 50,
        },
      ],
      toolCalls: [
        {
          id: `${SESSION_ID}-tc-1`,
          messageIdx: 1,
          tool: "Bash",
          args: JSON.stringify({ command: "ls" }),
          success: true,
          durationMs: 120,
        },
      ],
      fileOps: [
        { messageIdx: 1, filePath: "/workspace/src/index.ts", operation: "read" },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET /api/stats/exists/:sessionID → true after insert", async () => {
    const res = await req(`/api/stats/exists/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { exists: boolean };
    expect(body.exists).toBe(true);
  });

  it("POST /api/stats/session same ID → idempotent", async () => {
    const res = await json("/api/stats/session", {
      sessionID: SESSION_ID,
      run: {
        name: "smoke-run-1",
        namespace: "percussionist",
        phase: "Succeeded",
        tokensIn: 1000,
        tokensOut: 500,
      },
      messages: [],
      toolCalls: [],
      fileOps: [],
    });
    expect(res.status).toBe(200);
  });

  it("GET /api/stats/export → array includes posted session", async () => {
    const res = await req("/api/stats/export?days=0");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((s) => s.id === SESSION_ID);
    expect(found).toBeDefined();
  });

  it("GET /api/stats/sessions → paginated result with summary/agents/models", async () => {
    const res = await req("/api/stats/sessions?days=0");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThan(0);
    expect(body.summary).toBeDefined();
    expect((body.summary as Record<string, unknown>).total).toBeGreaterThan(0);
    expect(Array.isArray(body.agentSummaries)).toBe(true);
    expect(Array.isArray(body.modelRows)).toBe(true);
  });

  it("POST /api/stats/session missing sessionID → 400", async () => {
    const res = await json("/api/stats/session", { run: { name: "x" } });
    expect(res.status).toBe(400);
  });
});

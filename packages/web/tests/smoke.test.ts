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

const PROJECT = "smoke-test-proj";

describe("board API", () => {
  it("GET /api/board/:project on empty DB → 200 empty board", async () => {
    const res = await req(`/api/board/${PROJECT}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.columns).toEqual({});
    expect(body.workers).toEqual({});
    expect(body.activeWorkers).toBe(0);
  });

  it("POST /api/board/:project/seed → inserts 3 tasks", async () => {
    const res = await json(`/api/board/${PROJECT}/seed`, {
      tasks: [
        { taskId: "t1", column: "ready" },
        { taskId: "t2", column: "ready" },
        { taskId: "t3", column: "in-progress" },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.inserted).toBe(3);
    expect(body.skipped).toBe(0);
  });

  it("POST /api/board/:project/seed again → idempotent, skips all", async () => {
    const res = await json(`/api/board/${PROJECT}/seed`, {
      tasks: [
        { taskId: "t1", column: "ready" },
        { taskId: "t2", column: "ready" },
        { taskId: "t3", column: "in-progress" },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.inserted).toBe(0);
    expect(body.skipped).toBe(3);
  });

  it("GET /api/board/:project → tasks in correct columns", async () => {
    const res = await req(`/api/board/${PROJECT}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { columns: Record<string, string[]>; workers: Record<string, unknown>; activeWorkers: number };
    expect(body.columns["ready"]?.sort()).toEqual(["t1", "t2"]);
    expect(body.columns["in-progress"]).toEqual(["t3"]);
    expect(body.activeWorkers).toBe(0);
  });

  it("GET /api/board/:project/tasks/:taskId → task row, no worker", async () => {
    const res = await req(`/api/board/${PROJECT}/tasks/t1`);
    expect(res.status).toBe(200);
    const body = await res.json() as { task: Record<string, unknown>; worker: unknown };
    expect(body.task.taskId).toBe("t1");
    expect(body.task.column).toBe("ready");
    expect(body.worker).toBeNull();
  });

  it("GET /api/board/:project/tasks/missing → 404", async () => {
    const res = await req(`/api/board/${PROJECT}/tasks/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("POST /api/board/:project/tasks/:taskId/move → column updated", async () => {
    const res = await json(`/api/board/${PROJECT}/tasks/t1/move`, { column: "in-progress" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.column).toBe("in-progress");
  });

  it("GET /api/board/:project → t1 now in-progress", async () => {
    const res = await req(`/api/board/${PROJECT}`);
    const body = await res.json() as { columns: Record<string, string[]> };
    expect(body.columns["in-progress"]).toContain("t1");
    expect(body.columns["ready"]).not.toContain("t1");
  });

  it("POST move with no body → 400", async () => {
    const res = await req(`/api/board/${PROJECT}/tasks/t1/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("PUT /api/board/:project/workers/:taskId → upserts worker", async () => {
    const res = await json(
      `/api/board/${PROJECT}/workers/t1`,
      {
        runName: "proj-t1-run-0",
        status: "Running",
        retryCount: 0,
        branch: "feat/t1",
        facilitated: false,
        extra: { startedAt: "2025-01-01T00:00:00Z", reviewApproved: false },
      },
      "PUT",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.runName).toBe("proj-t1-run-0");
    expect(body.status).toBe("Running");
  });

  it("GET /api/board/:project → worker present, activeWorkers=1", async () => {
    const res = await req(`/api/board/${PROJECT}`);
    const body = await res.json() as { workers: Record<string, Record<string, unknown>>; activeWorkers: number };
    expect(body.workers["t1"]).toBeDefined();
    expect(body.workers["t1"]!.runName).toBe("proj-t1-run-0");
    expect((body.workers["t1"]!.extra as Record<string, unknown>)?.startedAt).toBe("2025-01-01T00:00:00Z");
    expect(body.activeWorkers).toBe(1);
  });

  it("PUT worker missing runName → 400", async () => {
    const res = await json(`/api/board/${PROJECT}/workers/t1`, { status: "Running" }, "PUT");
    expect(res.status).toBe(400);
  });

  it("DELETE /api/board/:project/workers/:taskId → 204", async () => {
    const res = await req(`/api/board/${PROJECT}/workers/t1`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("GET /api/board/:project → worker gone, activeWorkers=0", async () => {
    const res = await req(`/api/board/${PROJECT}`);
    const body = await res.json() as { workers: Record<string, unknown>; activeWorkers: number };
    expect(body.workers["t1"]).toBeUndefined();
    expect(body.activeWorkers).toBe(0);
  });

  it("POST /api/board/:project/sync → atomic full replace", async () => {
    // Sync: keep t1+t2 (moved to done/review), drop t3, add a worker for t1.
    const res = await json(`/api/board/${PROJECT}/sync`, {
      tasks: [
        { taskId: "t1", column: "done" },
        { taskId: "t2", column: "review" },
      ],
      workers: [
        {
          taskId: "t1",
          runName: "proj-t1-run-1",
          status: "Succeeded",
          retryCount: 1,
          facilitated: false,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.tasks).toBe(2);
    expect(body.workers).toBe(1);
  });

  it("GET /api/board/:project after sync → t3 pruned, t1 in done with worker", async () => {
    const res = await req(`/api/board/${PROJECT}`);
    const body = await res.json() as {
      columns: Record<string, string[]>;
      workers: Record<string, Record<string, unknown>>;
    };
    expect(body.columns["done"]).toContain("t1");
    expect(body.columns["review"]).toContain("t2");
    // t3 was not included in sync → pruned
    const allTasks = Object.values(body.columns).flat();
    expect(allTasks).not.toContain("t3");
    expect(body.workers["t1"]!.runName).toBe("proj-t1-run-1");
    expect(body.workers["t1"]!.status).toBe("Succeeded");
  });

  it("POST /api/board/:project/sync missing tasks array → 400", async () => {
    const res = await json(`/api/board/${PROJECT}/sync`, { workers: [] });
    expect(res.status).toBe(400);
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

  it("POST /api/stats/session missing sessionID → 400", async () => {
    const res = await json("/api/stats/session", { run: { name: "x" } });
    expect(res.status).toBe(400);
  });
});

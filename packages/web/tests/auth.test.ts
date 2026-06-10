// auth.test.ts — Regression tests for web API authentication middleware.
//
// Verifies that sensitive endpoints reject unauthenticated requests with 401,
// and that AUTH_DISABLED=1 provides a dev-mode bypass.
//
// Uses app.request() (no port binding) against the full Hono app built by
// createApp(). The K8s client is lazy — it only initialises on the first
// request that needs it.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";

// ---------------------------------------------------------------------------
// Test DB isolation

const TEST_DATA_DIR = join("/tmp", `percussionist-auth-${Date.now()}`);

process.env.DATA_DIR = TEST_DATA_DIR;

// Use a known secret for testing.
process.env.AUTH_SECRET = "test-secret-token-12345";
// Ensure auth is not disabled (smoke test may have set it).
delete process.env.AUTH_DISABLED;

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
// Helper: assert that a route rejects unauthenticated requests with 401.
// ===========================================================================

async function expectUnauthorized(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<void> {
  const res = await req(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(res.status).toBe(401);
  const data = (await res.json()) as { error?: string };
  expect(data.error).toBe("Unauthorized");
}

// Helper: assert that a route accepts requests with the correct token.
async function expectAuthenticated(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const res = await req(path, {
    method,
    headers: {
      ...((body ? { "Content-Type": "application/json" } : {})),
      Authorization: "Bearer test-secret-token-12345",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Should NOT be 401 — may be 404 (no K8s cluster), 500, or actual success.
  expect(res.status).not.toBe(401);
  return res;
}

// Helper: assert that a route rejects requests with the wrong token.
async function expectWrongTokenRejected(
  path: string,
  method = "GET",
): Promise<void> {
  const res = await req(path, {
    method,
    headers: { Authorization: "Bearer wrong-token" },
  });
  expect(res.status).toBe(401);
}

// ===========================================================================
// Health endpoint — always public (no auth required)
// ===========================================================================

describe("health", () => {
  it("GET /api/health → 200 without auth", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ===========================================================================
// Unauthenticated requests → 401 on protected endpoints
// ===========================================================================

describe("unauthenticated access → 401", () => {
  // Settings routes — all sensitive (secrets, cluster config)
  describe("settings (read)", () => {
    it("GET /api/settings → 401", async () => expectUnauthorized("/api/settings"));
    it("GET /api/settings/opencode-config → 401", async () =>
      expectUnauthorized("/api/settings/opencode-config"));
    it("GET /api/settings/decision-agent-default → 401", async () =>
      expectUnauthorized("/api/settings/decision-agent-default"));
    it("GET /api/settings/secrets → 401", async () =>
      expectUnauthorized("/api/settings/secrets"));
  });

  describe("settings (mutating)", () => {
    it("PUT /api/settings → 401", async () =>
      expectUnauthorized("/api/settings", "PUT", { spec: {} }));
    it("POST /api/settings/secrets → 401", async () =>
      expectUnauthorized("/api/settings/secrets", "POST", { name: "test", data: {} }));
    it("PUT /api/settings/secrets/test → 401", async () =>
      expectUnauthorized("/api/settings/secrets/test", "PUT", { data: {} }));
    it("DELETE /api/settings/secrets/test → 401", async () =>
      expectUnauthorized("/api/settings/secrets/test", "DELETE"));
  });

  // Projects routes — read-only needs auth, mutating needs admin auth
  describe("projects", () => {
    it("GET /api/projects → 401", async () => expectUnauthorized("/api/projects"));
    it("GET /api/projects/events → 401", async () =>
      expectUnauthorized("/api/projects/events"));
    it("GET /api/projects/config/default → 401", async () =>
      expectUnauthorized("/api/projects/config/default"));
    it("GET /api/projects/myproj/config → 401", async () =>
      expectUnauthorized("/api/projects/myproj/config"));
    it("GET /api/projects/myproj → 401", async () =>
      expectUnauthorized("/api/projects/myproj"));
    it("POST /api/projects → 401", async () =>
      expectUnauthorized("/api/projects", "POST", { displayName: "test" }));
    it("PUT /api/projects/myproj → 401", async () =>
      expectUnauthorized("/api/projects/myproj", "PUT", {}));
    it("DELETE /api/projects/myproj → 401", async () =>
      expectUnauthorized("/api/projects/myproj", "DELETE"));
  });

  // Runs routes — read-only needs auth, mutating needs admin auth
  describe("runs", () => {
    it("GET /api/runs → 401", async () => expectUnauthorized("/api/runs"));
    it("GET /api/runs/events → 401", async () =>
      expectUnauthorized("/api/runs/events"));
    it("GET /api/runs/myrun → 401", async () =>
      expectUnauthorized("/api/runs/myrun"));
    it("POST /api/runs → 401", async () =>
      expectUnauthorized("/api/runs", "POST", { task: "t1" }));
    it("DELETE /api/runs/myrun → 401", async () =>
      expectUnauthorized("/api/runs/myrun", "DELETE"));
    it("POST /api/runs/myrun/reply → 401", async () =>
      expectUnauthorized("/api/runs/myrun/reply", "POST", { message: "ok" }));
  });

  // Agents routes — read-only needs auth, mutating needs admin auth
  describe("agents", () => {
    it("GET /api/agents → 401", async () => expectUnauthorized("/api/agents"));
    it("GET /api/agents/events → 401", async () =>
      expectUnauthorized("/api/agents/events"));
    it("GET /api/agents/myagent → 401", async () =>
      expectUnauthorized("/api/agents/myagent"));
    it("POST /api/agents → 401", async () =>
      expectUnauthorized("/api/agents", "POST", { content: "test" }));
    it("PUT /api/agents/myagent → 401", async () =>
      expectUnauthorized("/api/agents/myagent", "PUT", {}));
    it("DELETE /api/agents/myagent → 401", async () =>
      expectUnauthorized("/api/agents/myagent", "DELETE"));
  });

  // Upgrade routes — status needs auth, apply needs admin auth
  describe("upgrade", () => {
    it("GET /api/upgrade/status → 401", async () =>
      expectUnauthorized("/api/upgrade/status"));
    it("POST /api/upgrade/apply → 401", async () =>
      expectUnauthorized("/api/upgrade/apply", "POST", { targetTag: "v1.0.0" }));
  });

  // Agent chat routes — all need auth (proxy to manager)
  describe("agent-chat", () => {
    it("POST /api/agent/chat → 401", async () =>
      expectUnauthorized("/api/agent/chat", "POST", { message: "hello" }));
    it("GET /api/agent/chat/stream → 401", async () =>
      expectUnauthorized("/api/agent/chat/stream"));
    it("GET /api/agent/chat/history → 401", async () =>
      expectUnauthorized("/api/agent/chat/history"));
    it("GET /api/agent/status → 401", async () =>
      expectUnauthorized("/api/agent/status"));
  });

  // Session routes — all need auth (expose session data)
  describe("session", () => {
    it("GET /api/runs/myrun/session → 401", async () =>
      expectUnauthorized("/api/runs/myrun/session"));
    it("GET /api/runs/myrun/session/events → 401", async () =>
      expectUnauthorized("/api/runs/myrun/session/events"));
  });

  // Logs routes — need auth (expose pod logs)
  describe("logs", () => {
    it("GET /api/runs/myrun/logs → 401", async () =>
      expectUnauthorized("/api/runs/myrun/logs"));
  });

  // Stats routes — all need auth (session data, metrics)
  describe("stats", () => {
    it("POST /api/stats/session → 401", async () =>
      expectUnauthorized("/api/stats/session", "POST", { sessionID: "x", run: { name: "y" } }));
    it("PATCH /api/stats/session → 401", async () =>
      expectUnauthorized("/api/stats/session", "PATCH", { sessionID: "x", run: { name: "y" } }));
    it("GET /api/stats/exists/sid → 401", async () =>
      expectUnauthorized("/api/stats/exists/sid"));
    it("GET /api/stats/export → 401", async () =>
      expectUnauthorized("/api/stats/export"));
    it("GET /api/stats/sessions → 401", async () =>
      expectUnauthorized("/api/stats/sessions"));
    it("GET /api/stats/tool-metrics → 401", async () =>
      expectUnauthorized("/api/stats/tool-metrics"));
  });

  // Metrics routes — need auth (cluster resource data)
  describe("metrics", () => {
    it("GET /api/metrics/nodes → 401", async () =>
      expectUnauthorized("/api/metrics/nodes"));
    it("GET /api/metrics/pods → 401", async () =>
      expectUnauthorized("/api/metrics/pods"));
    it("GET /api/metrics/events → 401", async () =>
      expectUnauthorized("/api/metrics/events"));
  });

  // Providers route — need auth (LLM provider config)
  describe("providers", () => {
    it("GET /api/providers → 401", async () =>
      expectUnauthorized("/api/providers"));
  });

  // Activity route — needs auth (task event history)
  describe("activity", () => {
    it("GET /api/activity → 401", async () =>
      expectUnauthorized("/api/activity"));
  });

  // Board-db routes — need auth (audit log data)
  describe("board-db", () => {
    it("GET /api/board/myproj/events → 401", async () =>
      expectUnauthorized("/api/board/myproj/events"));
    it("GET /api/board/myproj/tasks/t1/events → 401", async () =>
      expectUnauthorized("/api/board/myproj/tasks/t1/events"));
  });

  // Plans route — needs auth (plan artifacts)
  describe("plans", () => {
    it("GET /api/projects/myproj/plans/t1 → 401", async () =>
      expectUnauthorized("/api/projects/myproj/plans/t1"));
  });

  // Task-diff route — needs auth (executes commands via manager)
  describe("task-diff", () => {
    it("GET /api/projects/myproj/tasks/t1/diff → 401", async () =>
      expectUnauthorized("/api/projects/myproj/tasks/t1/diff"));
  });

  // Board routes — read-only needs auth, mutating needs admin auth
  describe("board (read)", () => {
    it("GET /api/projects/myproj/board → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board"));
    it("GET /api/projects/myproj/board/events → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/events"));
  });

  describe("board (mutating)", () => {
    it("PATCH /api/projects/myproj/board/spec → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/spec", "PATCH", {}));
    it("POST /api/projects/myproj/board/tasks → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/tasks", "POST", { type: "PLAN", title: "t", agent: "planner" }));
    it("DELETE /api/projects/myproj/board/tasks/t1 → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/tasks/t1", "DELETE"));
    it("POST /api/projects/myproj/board/tasks/t1/move → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/tasks/t1/move", "POST", { column: "ready" }));
    it("POST /api/projects/myproj/board/tasks/t1/approve → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/tasks/t1/approve", "POST"));
    it("POST /api/projects/myproj/board/tasks/t1/request-changes → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/tasks/t1/request-changes", "POST", { feedback: "fix this" }));
    it("POST /api/projects/myproj/board/tasks/t1/abandon → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/tasks/t1/abandon", "POST"));
    it("POST /api/projects/myproj/board/tasks/t1/answer → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/tasks/t1/answer", "POST", { answer: "yes" }));
    it("POST /api/projects/myproj/board/task-events → 401", async () =>
      expectUnauthorized("/api/projects/myproj/board/task-events", "POST", { taskName: "t1", taskType: "PLAN", eventType: "created" }));
  });
});

// ===========================================================================
// Wrong token → 401 on protected endpoints
// ===========================================================================

describe("wrong token → 401", () => {
  it("GET /api/settings with wrong Bearer token → 401", async () =>
    expectWrongTokenRejected("/api/settings"));
  it("GET /api/projects with x-auth-token header → 401", async () => {
    const res = await req("/api/projects", {
      headers: { "x-auth-token": "wrong-token" },
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// AUTH_DISABLED=1 — dev mode bypass (tested by re-creating app)
// ===========================================================================

describe("AUTH_DISABLED=1 bypass", () => {
  it("GET /api/settings is accessible without token when AUTH_DISABLED=1", async () => {
    // Re-create the app with AUTH_DISABLED set.
    process.env.AUTH_DISABLED = "1";
    const devApp = createApp();

    const res = await devApp.request("/api/settings");
    expect(res.status).not.toBe(401);
  });

  it("POST /api/projects is accessible without token when AUTH_DISABLED=1", async () => {
    process.env.AUTH_DISABLED = "1";
    const devApp = createApp();

    const res = await devApp.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "test" }),
    });
    expect(res.status).not.toBe(401);
  });

  // Restore original env for other tests.
  afterAll(() => {
    delete process.env.AUTH_DISABLED;
  });
});

// ===========================================================================
// x-auth-token header variant
// ===========================================================================

describe("x-auth-token header", () => {
  it("GET /api/settings with valid x-auth-token → not 401", async () => {
    const res = await req("/api/settings", {
      headers: { "x-auth-token": "test-secret-token-12345" },
    });
    expect(res.status).not.toBe(401);
  });

  it("POST /api/runs with valid x-auth-token → not 401", async () => {
    const res = await req("/api/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-auth-token": "test-secret-token-12345",
      },
      body: JSON.stringify({ task: "t1" }),
    });
    expect(res.status).not.toBe(401);
  });
});

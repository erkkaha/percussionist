// app.ts — Hono app factory, no side-effects.
//
// Exported so tests can import just the app without triggering Bun.serve(),
// getDb() eager init, setInterval, or any other startup side-effects.

import { Hono } from "hono";
import { logger } from "hono/logger";
import { compress } from "hono/compress";
import runs from "./routes/runs.js";
import logs from "./routes/logs.js";
import session from "./routes/session.js";
import stats from "./routes/stats.js";
import projects from "./routes/projects.js";
import agents from "./routes/agents.js";
import board from "./routes/board.js";
import boardDb from "./routes/board-db.js";
import metrics from "./routes/metrics.js";
import agentChat from "./routes/agent-chat.js";
import settings from "./routes/settings.js";
import activity from "./routes/activity.js";
import plans from "./routes/plans.js";
import taskDiff from "./routes/task-diff.js";
import upgrade from "./routes/upgrade.js";
import providers from "./routes/providers.js";
import { NAMESPACE } from "./kube.js";

export function createApp() {
  const app = new Hono();

  app.use("*", logger());
  app.use("*", compress());

  app.route("/api/runs", runs);
  app.route("/api/runs", logs);
  app.route("/api/runs", session);
  app.route("/api/stats", stats);
  app.route("/api/projects", projects);
  app.route("/api/agents", agents);
  app.route("/api/projects", board);
  app.route("/api/board", boardDb);
  app.route("/api/metrics", metrics);
  app.route("/api/agent", agentChat);
  app.route("/api/settings", settings);
  app.route("/api/activity", activity);
  app.route("/api/projects", plans);
  app.route("/api/projects", taskDiff);
  app.route("/api/upgrade", upgrade);
  app.route("/api/providers", providers);

  app.get("/api/health", (c) => c.json({ ok: true, namespace: NAMESPACE }));

  return app;
}

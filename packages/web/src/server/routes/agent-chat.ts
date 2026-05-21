// routes/agent-chat.ts — proxies chat messages to the manager's agent handler.
//
// The manager exposes a chat API on port 4098 inside its pod.
// A ClusterIP Service (percussionist-manager) makes it reachable at:
//   http://percussionist-manager.{ns}.svc.cluster.local:4098
//
// The web dashboard talks to this proxy instead of reaching into the cluster
// directly, keeping the client simple.

import { Hono } from "hono";
import { NAMESPACE } from "../kube.js";

const router = new Hono();

const MANAGER_SERVICE = `http://percussionist-manager.${NAMESPACE}.svc.cluster.local`;
const CHAT_URL = `${MANAGER_SERVICE}:4098`;

// POST /api/agent/chat — send a message to the manager agent, get response.
router.post("/chat", async (c) => {
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort());

  try {
    const body = await c.req.json();
    const res = await fetch(`${CHAT_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    const data = await res.json();
    return c.json(data, res.status as Parameters<typeof c.json>[1]);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("aborted")) {
      return c.json({ cancelled: true }, 502);
    }
    return c.json({ error: msg }, 502);
  }
});

// GET /api/agent/chat/stream — SSE stream of the agent conversation.
router.get("/chat/stream", async (c) => {
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort());

  try {
    const upstream = await fetch(`${CHAT_URL}/chat/stream`, {
      signal: abortController.signal,
    });
    if (!upstream.ok || !upstream.body) {
      return c.text("agent stream unavailable", 502);
    }

    // Relay the SSE stream to the client.
    const reader = upstream.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch {
          controller.close();
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return c.text("agent stream error", 502);
  }
});

// GET /api/agent/chat/history — get conversation history.
router.get("/chat/history", async (c) => {
  try {
    const res = await fetch(`${CHAT_URL}/chat/history`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return c.json({ history: [], sessionId: null });
    }
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ history: [], sessionId: null });
  }
});

// GET /api/agent/status — check if the agent is reachable.
router.get("/status", async (c) => {
  try {
    const res = await fetch(`${CHAT_URL}/chat/history`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      return c.json({ available: true });
    }
    return c.json({ available: false, status: res.status });
  } catch {
    return c.json({ available: false });
  }
});

export default router;

// agent/chat-handler.ts — HTTP server for interactive chat with the agent.
//
// Exposes two endpoints on AGENT_CHAT_PORT (default 4098):
//   POST /chat — send a message, returns the agent's response
//   GET  /chat/stream — SSE stream of the conversation
//
// The web dashboard and CLI connect here to talk to the agent interactively.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CHAT_PORT } from "./config.js";
import {
  createSession,
  sendMessage,
  getMessages,
  waitForCompletion,
  extractLastAssistantText,
} from "./session.js";

const log = (...args: unknown[]) =>
  console.log(`[agent-chat ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[agent-chat ${new Date().toISOString()}]`, ...args);

let currentSessionId: string | null = null;
let conversationHistory: Array<{ role: "user" | "assistant"; text: string }> = [];

async function ensureSession(): Promise<string> {
  if (currentSessionId) {
    // Verify the session still exists
    try {
      const msgs = await getMessages(currentSessionId);
      if (msgs) return currentSessionId;
    } catch {
      // Session gone — create new one
    }
  }
  const id = await createSession("manager-interactive");
  currentSessionId = id;
  conversationHistory = [];
  log(`created interactive session ${id}`);
  return id;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

interface ChatRequest {
  message: string;
}

export function startChatServer(): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "POST" && req.url === "/chat") {
        await handleChat(req, res);
      } else if (req.method === "GET" && req.url === "/chat/stream") {
        await handleStream(req, res);
      } else if (req.method === "GET" && req.url === "/chat/history") {
        sendJson(res, 200, { history: conversationHistory, sessionId: currentSessionId });
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    } catch (e) {
      err("chat handler error:", (e as Error).message);
      if (!res.headersSent) {
        sendJson(res, 500, { error: (e as Error).message });
      }
    }
  });

  server.listen(CHAT_PORT, "127.0.0.1", () => {
    log(`chat handler listening on 127.0.0.1:${CHAT_PORT}`);
  });

  server.on("error", (e) => {
    err("chat server error:", (e as Error).message);
  });
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let chatReq: ChatRequest;
  try {
    chatReq = JSON.parse(body) as ChatRequest;
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }

  const message = chatReq.message ?? "";
  if (!message) {
    sendJson(res, 400, { error: "message is required" });
    return;
  }

  conversationHistory.push({ role: "user", text: message });

  try {
    const sessionId = await ensureSession();
    await sendMessage(sessionId, message);

    const response = await waitForCompletion(sessionId, 120_000);
    if (response) {
      conversationHistory.push({ role: "assistant", text: response });
      sendJson(res, 200, { response, sessionId });
    } else {
      sendJson(res, 200, { response: "Agent did not respond in time. Please try again.", sessionId });
    }
  } catch (e) {
    err("chat message failed:", (e as Error).message);
    sendJson(res, 500, { error: (e as Error).message });
  }
}

async function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send existing history
  for (const msg of conversationHistory) {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  // Poll for new messages and stream them
  const sessionId = currentSessionId;
  if (!sessionId) {
    res.write(`data: ${JSON.stringify({ role: "system", text: "No active session. Send a message to start one." })}\n\n`);
    res.end();
    return;
  }

  const knownMessageCount = new Set<string>();
  const poll = setInterval(async () => {
    try {
      const messages = await getMessages(sessionId);
      for (const msg of messages) {
        const id = msg.info?.id;
        if (!id || knownMessageCount.has(id)) continue;
        knownMessageCount.add(id);
        if (msg.info?.role === "assistant") {
          let text = "";
          for (const part of msg.parts ?? []) {
            if (part.type === "text" && part.text) text += part.text;
          }
          if (text) {
            res.write(`data: ${JSON.stringify({ role: "assistant", text, completed: !!msg.info?.time?.completed })}\n\n`);
          }
        }
      }
    } catch {
      // ignore poll errors
    }
  }, 2000);

  req.on("close", () => {
    clearInterval(poll);
  });

  req.on("error", () => {
    clearInterval(poll);
  });
}

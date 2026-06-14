// agent/chat-handler.ts — HTTP server for interactive chat with the agent.
//
// Exposes two endpoints on AGENT_CHAT_PORT (default 4098):
//   POST /chat — send a message, returns the agent's response
//   GET  /chat/stream — SSE stream of the conversation
//
// Conversation history is persisted to a ConfigMap (manager-chat-history)
// so it survives pod restarts. If the ConfigMap is unavailable the handler
// degrades gracefully (in-memory only).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import { core } from '@percussionist/kube';
import { getErrorStatusCode, isKubeNotFoundError } from '../kube-errors.js';
import {
  CHAT_PORT,
  DECISION_AGENT_NAME,
  FIRST_RESPONSE_TIMEOUT_MS,
  MANAGER_NAMESPACE as NAMESPACE,
} from './config.js';
import { createSession, getMessages, sendMessage, waitForCompletion } from './session.js';

const CONFIGMAP_NAME = 'manager-chat-history';
const SAVE_DEBOUNCE_MS = 2000;

const log = (...args: unknown[]) =>
  console.log(`[agent-chat ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[agent-chat ${new Date().toISOString()}]`, ...args);

let currentSessionId: string | null = null;
let conversationHistory: Array<{ role: 'user' | 'assistant'; text: string }> = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// ConfigMap persistence

async function loadHistoryFromConfigMap(): Promise<void> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: NAMESPACE,
    });
    const raw = cm.data?.['history.json'];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every(
          (m: unknown) =>
            typeof m === 'object' &&
            m !== null &&
            (m as Record<string, unknown>).role &&
            (m as Record<string, unknown>).text,
        )
      ) {
        conversationHistory = parsed;
        log(`restored ${conversationHistory.length} messages from ConfigMap`);
      }
    }
  } catch (e: unknown) {
    // 404 = ConfigMap doesn't exist yet (first run). Other errors are logged.
    if (!isKubeNotFoundError(e)) {
      log(`failed to load chat history from ConfigMap: ${(e as Error).message}`);
    }
  }
}

async function saveHistoryToConfigMap(): Promise<void> {
  const data = JSON.stringify(conversationHistory.slice(-100)); // Keep last 100 messages
  try {
    // Try patch first (faster if ConfigMap exists)
    await core().patchNamespacedConfigMap(
      {
        name: CONFIGMAP_NAME,
        namespace: NAMESPACE,
        body: {
          data: { 'history.json': data },
        },
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  } catch (e: unknown) {
    const status = getErrorStatusCode(e);
    if (status === 404) {
      // ConfigMap doesn't exist — create it
      try {
        await core().createNamespacedConfigMap({
          namespace: NAMESPACE,
          body: {
            metadata: {
              name: CONFIGMAP_NAME,
              labels: {
                'app.kubernetes.io/name': 'percussionist',
                'app.kubernetes.io/component': 'manager',
              },
            },
            data: { 'history.json': data },
          },
        });
        return;
      } catch (createErr) {
        err(`failed to create chat history ConfigMap: ${(createErr as Error).message}`);
        return;
      }
    }
    err(`failed to save chat history to ConfigMap: ${(e as Error).message}`);
  }
}

function debouncedSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveHistoryToConfigMap();
  }, SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Session management

async function ensureSession(): Promise<string> {
  if (currentSessionId) {
    try {
      const msgs = await getMessages(currentSessionId);
      if (msgs) return currentSessionId;
    } catch {
      // Session gone — create new one
    }
  }
  const id = await createSession('manager-interactive', DECISION_AGENT_NAME);
  currentSessionId = id;
  conversationHistory = [];
  log(`created interactive session ${id}`);
  return id;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

interface ChatRequest {
  message: string;
}

export async function startChatServer(): Promise<void> {
  // Restore conversation history from ConfigMap on startup
  await loadHistoryFromConfigMap();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'POST' && req.url === '/chat') {
        await handleChat(req, res);
      } else if (req.method === 'GET' && req.url === '/chat/stream') {
        await handleStream(req, res);
      } else if (req.method === 'GET' && req.url === '/chat/history') {
        sendJson(res, 200, { history: conversationHistory, sessionId: currentSessionId });
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    } catch (e) {
      err('chat handler error:', (e as Error).message);
      if (!res.headersSent) {
        sendJson(res, 500, { error: (e as Error).message });
      }
    }
  });

  server.listen(CHAT_PORT, '0.0.0.0', () => {
    log(`chat handler listening on 0.0.0.0:${CHAT_PORT}`);
  });

  server.on('error', (e) => {
    err('chat server error:', (e as Error).message);
  });
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let chatReq: ChatRequest;
  try {
    chatReq = JSON.parse(body) as ChatRequest;
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return;
  }

  const message = chatReq.message ?? '';
  if (!message) {
    sendJson(res, 400, { error: 'message is required' });
    return;
  }

  conversationHistory.push({ role: 'user', text: message });
  debouncedSave();

  const abortController = new AbortController();
  const onClose = () => {
    abortController.abort();
  };
  req.on('close', onClose);
  req.on('error', onClose);

  try {
    const sessionId = await ensureSession();
    const sendController = new AbortController();
    abortController.signal.addEventListener('abort', () => sendController.abort(), { once: true });
    const sendPromise = sendMessage(sessionId, message, DECISION_AGENT_NAME, sendController.signal);
    const sendFailure = sendPromise.then(() => new Promise<void>(() => {}));

    const frto = FIRST_RESPONSE_TIMEOUT_MS > 0 ? FIRST_RESPONSE_TIMEOUT_MS : undefined;
    const response = await Promise.race([
      waitForCompletion(sessionId, 0, frto, abortController.signal),
      sendFailure,
    ]);
    sendController.abort();
    if (response) {
      conversationHistory.push({ role: 'assistant', text: response });
      debouncedSave();
      sendJson(res, 200, { response, sessionId });
    } else if (abortController.signal.aborted) {
      sendJson(res, 200, { cancelled: true, sessionId });
    } else {
      sendJson(res, 200, {
        response: 'Agent did not respond in time. Please try again.',
        sessionId,
      });
    }
  } catch (e) {
    err('chat message failed:', (e as Error).message);
    sendJson(res, 500, { error: (e as Error).message });
  }
}

async function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Poll for new messages and stream them (history is loaded separately via GET /chat/history)
  const sessionId = currentSessionId;
  if (!sessionId) {
    res.write(`event: ready\ndata: {}\n\n`);
    res.end();
    return;
  }

  // Signal to the client that SSE is live and history has been fetched separately
  res.write(`event: ready\ndata: {}\n\n`);

  const knownMessageCount = new Set<string>();
  const poll = setInterval(async () => {
    try {
      const messages = await getMessages(sessionId);
      for (const msg of messages) {
        const id = msg.info?.id;
        if (!id || knownMessageCount.has(id)) continue;
        knownMessageCount.add(id);
        if (msg.info?.role === 'assistant') {
          let text = '';
          for (const part of msg.parts ?? []) {
            if (part.type === 'text' && part.text) text += part.text;
          }
          if (text) {
            res.write(
              `data: ${JSON.stringify({ role: 'assistant', text, completed: !!msg.info?.time?.completed, id: msg.info?.id, created: msg.info?.time?.created })}\n\n`,
            );
          }
        }
      }
    } catch {
      // ignore poll errors
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(poll);
  });

  req.on('error', () => {
    clearInterval(poll);
  });
}

// tool-events-reporter.ts — captures tool invocation metrics during a run.
//
// Two sources of tool events:
//   1. SSE events from OpenCode's /event stream (native tools: grep, glob, read, edit)
//   2. MCP middleware wrapping tools/call dispatches (dispatcher MCP tools)
//
// Events are batched and flushed periodically to the web stats endpoint.

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";
const WEB_URL =
  process.env.WEB_SERVICE_URL ??
  `http://percussionist-web.${NAMESPACE}.svc.cluster.local:8080`;

const log = (...args: unknown[]) =>
  console.log(`[tool-events ${new Date().toISOString()}]`, ...args);

const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFERED_EVENTS = 500;

interface ToolEvent {
  id: string;
  sessionId: string;
  runName: string;
  toolName: string;
  isMcp: boolean;
  calledAt: string;
  durationMs?: number;
  success?: boolean;
  resultSize?: number;
  resultTruncated?: boolean;
  error?: string;
}

// Track started tool calls (from SSE tool.started) keyed by tool call ID.
const startedCalls = new Map<string, { tool: string; calledAt: string }>();

let eventBuffer: ToolEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let _runName = "";
let _sessionId = "";

export function initToolEvents(runName: string, sessionId: string): void {
  _runName = runName;
  _sessionId = sessionId;
}

// ---------------------------------------------------------------------------
// Record a tool event (called from MCP middleware or SSE parser)

let eventIdCounter = 0;

export function recordToolEvent(event: Omit<ToolEvent, "id" | "runName" | "sessionId">): void {
  eventBuffer.push({
    ...event,
    id: `te-${++eventIdCounter}`,
    runName: _runName,
    sessionId: _sessionId,
  });
  if (eventBuffer.length >= MAX_BUFFERED_EVENTS) {
    flushToolEvents();
  }
  scheduleFlush();
}

// ---------------------------------------------------------------------------
// SSE event handler — called when parsing SSE events from OpenCode's /event stream.
// OpenCode emits tool.started and tool.finished events for native tools (grep, glob, etc.).

export function handleToolSseEvent(eventType: string, properties: Record<string, unknown>): void {
  if (eventType === "tool.started") {
    const toolId = String(properties.id ?? "");
    const tool = String(properties.tool ?? "");
    if (toolId && tool) {
      startedCalls.set(toolId, { tool, calledAt: new Date().toISOString() });
    }
  } else if (eventType === "tool.finished") {
    const toolId = String(properties.id ?? "");
    const started = startedCalls.get(toolId);
    if (started) {
      startedCalls.delete(toolId);
      recordToolEvent({
        toolName: started.tool,
        isMcp: false,
        calledAt: started.calledAt,
        durationMs: typeof properties.duration === "number" ? properties.duration : undefined,
        success: typeof properties.success === "boolean" ? properties.success : undefined,
        resultSize: typeof properties.resultSize === "number" ? properties.resultSize : undefined,
        resultTruncated: typeof properties.truncated === "boolean" ? properties.truncated : undefined,
        error: properties.error ? String(properties.error) : undefined,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// MCP middleware wrapper — record MCP tool calls with timing.

export function wrapMcpCall<T>(toolName: string, fn: () => T): T {
  const calledAt = new Date().toISOString();
  const start = Date.now();
  let success = true;
  let errorMsg: string | undefined;
  let resultSize: number | undefined;
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (res) => {
          resultSize = approximateSize(res);
          recordToolEvent({
            toolName, isMcp: true, calledAt, success: true, resultSize,
            durationMs: Date.now() - start,
          });
          return res;
        },
        (err) => {
          errorMsg = (err as Error).message;
          recordToolEvent({
            toolName, isMcp: true, calledAt, success: false, error: errorMsg,
            durationMs: Date.now() - start,
          });
          throw err;
        },
      ) as T;
    }
    resultSize = approximateSize(result);
    recordToolEvent({
      toolName, isMcp: true, calledAt, success: true, resultSize,
      durationMs: Date.now() - start,
    });
    return result;
  } catch (e) {
    errorMsg = (e as Error).message;
    recordToolEvent({
      toolName, isMcp: true, calledAt, success: false, error: errorMsg,
      durationMs: Date.now() - start,
    });
    throw e;
  }
}

export async function wrapMcpCallAsync<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  const calledAt = new Date().toISOString();
  const start = Date.now();
  try {
    const result = await fn();
    recordToolEvent({
      toolName, isMcp: true, calledAt, success: true,
      resultSize: approximateSize(result),
      durationMs: Date.now() - start,
    });
    return result;
  } catch (e) {
    recordToolEvent({
      toolName, isMcp: true, calledAt, success: false,
      error: (e as Error).message,
      durationMs: Date.now() - start,
    });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Flush

function approximateSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToolEvents();
  }, FLUSH_INTERVAL_MS);
}

function flushToolEvents(): void {
  const batch = eventBuffer;
  eventBuffer = [];
  if (batch.length === 0) return;
  if (!WEB_URL) return;

  fetch(`${WEB_URL}/api/stats/tool-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: batch }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => {
    log(`flush failed (non-fatal): ${(e as Error).message}`);
  });
}

export function flushNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushToolEvents();
}

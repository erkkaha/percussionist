// model-warmup.ts — Ensures the embedding model is present in Ollama before
// the memory service starts accepting requests.
//
// Workflow:
//   1. Check model presence via GET /api/tags
//   2. If absent, trigger pull via POST /api/pull (streamed) and wait for completion
//   3. Retry with bounded exponential backoff for transient failures
//
// Environment variables:
//   EMBEDDING_MODEL       — Model name to warm up (default: nomic-embed-text)
//   OLLAMA_BASE_URL       — Ollama service URL (default from embed.ts)
//   WARMUP_ENABLED        — Toggle auto-warmup on/off (default: "true")
//   WARMUP_TIMEOUT_MS     — Max total time for warmup in ms (default: 300_000 = 5 min)
//   WARMUP_MAX_RETRIES    — Max retry attempts for transient failures (default: 6)

const DEFAULT_BASE_URL = "http://ollama.percussionist.svc.cluster.local:11434";
const DEFAULT_MODEL = "nomic-embed-text";

// ---------------------------------------------------------------------------
// Internal state — shared with routes.ts for health checks

let _ready: boolean | null = null; // null = not yet checked
let _error: string | null = null;

export function isModelReady(): boolean {
  return _ready === true;
}

export function getModelError(): string | null {
  return _error;
}

// Called by tests to reset module state between test runs.
export function resetState(): void {
  _ready = null;
  _error = null;
}

// ---------------------------------------------------------------------------
// Config — read dynamically so tests can override env vars at runtime.

function getConfig() {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL,
    model: process.env.EMBEDDING_MODEL ?? DEFAULT_MODEL,
    enabled: process.env.WARMUP_ENABLED !== "false",
    timeoutMs: parseInt(process.env.WARMUP_TIMEOUT_MS ?? "300000", 10),
    maxRetries: parseInt(process.env.WARMUP_MAX_RETRIES ?? "6", 10),
  };
}

// ---------------------------------------------------------------------------
// Ollama API helpers

interface OllamaTagEntry {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: unknown;
}

interface TagsResponse {
  models: OllamaTagEntry[];
}

async function getTags(baseUrl: string): Promise<OllamaTagEntry[]> {
  const res = await fetch(`${baseUrl}/api/tags`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`tags request failed (${res.status})`);
  const data = (await res.json()) as TagsResponse;
  return data.models ?? [];
}

function modelExists(models: OllamaTagEntry[], name: string): boolean {
  return models.some((m) => m.name === name || m.model === name);
}

interface PullStreamEvent {
  status?: string;
  error?: string;
}

async function pullModel(baseUrl: string, name: string, timeoutMs: number): Promise<void> {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`pull request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  // Read the streamed response until we get a "done" status or an error.
  if (!res.body) {
    throw new Error("pull response has no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete JSON lines from the buffer.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event: PullStreamEvent = JSON.parse(line);
        console.log(`[memory] warmup pull: ${event.status ?? "unknown"}`);
        if (event.error) {
          throw new Error(`pull error: ${event.error}`);
        }
        if (event.status === "success" || event.status === "done") {
          return; // model pulled successfully
        }
      } catch (_e) {
        // Non-JSON line or parse error — skip it.
        console.warn(`[memory] warmup pull: skipping non-JSON line`);
      }
    }
  }

  // If we exhausted the stream without a success/done status, that's unexpected.
  throw new Error("pull stream ended without success status");
}

// ---------------------------------------------------------------------------
// Main warmup function

export async function warmupModel(): Promise<void> {
  const cfg = getConfig();

  if (!cfg.enabled) {
    console.log("[memory] warmup disabled via WARMUP_ENABLED=false, skipping");
    _ready = true; // skip is fine — caller will fail on first embedding call
    return;
  }

  const startTime = Date.now();
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter, capped at 30s.
      const baseDelayMs = Math.min(1_000 * Math.pow(2, attempt - 1), 30_000);
      const jitter = Math.random() * baseDelayMs * 0.5;
      const delay = baseDelayMs + jitter;
      console.log(
        `[memory] warmup: retry ${attempt}/${cfg.maxRetries} in ${Math.round(delay)}ms`,
      );
      await sleep(delay);

      // Check total timeout before proceeding with retry.
      if (Date.now() - startTime > cfg.timeoutMs) {
        lastError = `warmup timed out after ${Math.round((Date.now() - startTime) / 1000)}s`;
        break;
      }
    }

    try {
      // Step 1: Check if model is already present.
      const tags = await getTags(cfg.baseUrl);
      if (modelExists(tags, cfg.model)) {
        console.log(
          `[memory] warmup: model "${cfg.model}" already present (${tags.length} total)`,
        );
        _ready = true;
        return;
      }

      // Step 2: Pull the missing model.
      console.log(`[memory] warmup: pulling model "${cfg.model}"...`);
      await pullModel(cfg.baseUrl, cfg.model, cfg.timeoutMs);

      // Step 3: Verify it's now present (post-pull sanity check).
      const postTags = await getTags(cfg.baseUrl);
      if (!modelExists(postTags, cfg.model)) {
        throw new Error("pull reported success but model not found in tags");
      }

      console.log(
        `[memory] warmup: model "${cfg.model}" ready after ${Math.round((Date.now() - startTime) / 1000)}s`,
      );
      _ready = true;
      return;
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`[memory] warmup attempt ${attempt + 1} failed: ${lastError}`);

      // If this was the last retry, record failure and exit.
      if (attempt === cfg.maxRetries) {
        _ready = false;
        _error = `warmup failed after ${cfg.maxRetries + 1} attempts: ${lastError}`;
        console.error(`[memory] warmup: giving up — ${_error}`);
      }
    }
  }

  // If we exit the loop without returning, _ready is already set to false.
  if (_ready === null) {
    _ready = false;
    _error = lastError ?? "warmup completed without setting ready state";
  }
}

// ---------------------------------------------------------------------------
// Helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

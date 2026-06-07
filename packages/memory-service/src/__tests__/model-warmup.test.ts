import { describe, it, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers — override globalThis.fetch to intercept Ollama API calls.
// Env vars are read at warmupModel() call time (not import time), so tests
// can set them freely before each test.
// ---------------------------------------------------------------------------

type FetchHandler = (req: Request) => Response | Promise<Response>;

function withFetchMock(handler: FetchHandler): () => void {
  const originalFetch = globalThis.fetch;
  // @ts-expect-error — replacing fetch for the duration of this mock.
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return handler(req);
  };

  return () => {
    // @ts-expect-error — restoring fetch.
    globalThis.fetch = originalFetch;
  };
}

// ---------------------------------------------------------------------------
// Test: model already present — no pull needed

describe("warmupModel — model already present", () => {
  it("skips pull when model exists in tags", async () => {
    const restore = withFetchMock(() =>
      new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Reset state so previous tests don't leak.
    const mod = await import("../model-warmup.js");
    if ("resetState" in mod) (mod as any).resetState();

    try {
      await mod.warmupModel();
      expect(mod.isModelReady()).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: model missing then pull succeeds

describe("warmupModel — pull succeeds", () => {
  it("pulls the model when absent and reports ready", async () => {
    let callCount = 0;
    const restore = withFetchMock((req) => {
      const url = req.url;
      if (url.includes("/api/tags")) {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ models: [] }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ models: [{ name: "nomic-embed-text" }] }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/pull")) {
        const stream = new Blob([
          '{"status":"pulling manifest"}\n',
          '{"status":"downloading"}\n',
          '{"status":"success"}\n',
        ]).stream() as unknown as ReadableStream<Uint8Array>;
        return new Response(stream, { headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });

    const mod = await import("../model-warmup.js");
    if ("resetState" in mod) (mod as any).resetState();

    try {
      await mod.warmupModel();
      expect(mod.isModelReady()).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: pull failure / timeout

describe("warmupModel — pull fails", () => {
  it("reports not-ready when model cannot be pulled", async () => {
    const restore = withFetchMock((req) => {
      if (req.url.includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (req.url.includes("/api/pull")) {
        return new Response(
          JSON.stringify({ error: "model not found on registry" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    process.env.WARMUP_MAX_RETRIES = "1";
    const mod = await import("../model-warmup.js");
    if ("resetState" in mod) (mod as any).resetState();

    try {
      await mod.warmupModel();
      expect(mod.isModelReady()).toBe(false);
      const err = mod.getModelError();
      expect(err).toBeDefined();
      expect(typeof err).toBe("string");
      expect(err!.length).toBeGreaterThan(0);
    } finally {
      delete process.env.WARMUP_MAX_RETRIES;
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: transient Ollama unavailable then retry success

describe("warmupModel — transient failure then success", () => {
  it("retries when Ollama is temporarily unreachable", async () => {
    let tagCallCount = 0;
    const restore = withFetchMock((req) => {
      if (req.url.includes("/api/tags")) {
        tagCallCount++;
        // First call fails, second succeeds.
        if (tagCallCount === 1) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response(
          JSON.stringify({ models: [{ name: "nomic-embed-text" }] }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (req.url.includes("/api/pull")) {
        // Should not reach pull — model appears after retries.
        return new Response("unexpected", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });

    process.env.WARMUP_MAX_RETRIES = "1";
    const mod = await import("../model-warmup.js");
    if ("resetState" in mod) (mod as any).resetState();

    try {
      await mod.warmupModel();
      expect(mod.isModelReady()).toBe(true);
    } finally {
      delete process.env.WARMUP_MAX_RETRIES;
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: WARMUP_ENABLED=false skips warmup

describe("warmupModel — disabled", () => {
  it("skips all checks when WARMUP_ENABLED=false", async () => {
    let fetchCalled = false;
    const restore = withFetchMock(() => {
      fetchCalled = true;
      return new Response("unexpected");
    });

    process.env.WARMUP_ENABLED = "false";
    const mod = await import("../model-warmup.js");
    if ("resetState" in mod) (mod as any).resetState();

    try {
      await mod.warmupModel();
      expect(fetchCalled).toBe(false);
      expect(mod.isModelReady()).toBe(true); // skip = ready for health purposes
    } finally {
      delete process.env.WARMUP_ENABLED;
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: isModelReady / getModelError state accessors

describe("state accessors", () => {
  it("returns correct initial state before warmup runs", async () => {
    const mod = await import("../model-warmup.js");
    if ("resetState" in mod) (mod as any).resetState();
    expect(mod.isModelReady()).toBe(false); // null coerces to false
    expect(mod.getModelError()).toBeNull();
  });
});

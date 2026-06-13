import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock storeMemory to throw — simulates memory service outage.
// Must be set up before importing the summarizer module.
// ---------------------------------------------------------------------------

const FAKE_MEMORY_ERROR = new Error('ECONNREFUSED: connection refused');

mock.module('../agent/memory-client.js', () => ({
  storeMemory: async (
    _project: string,
    _content: string,
    _metadata?: Record<string, unknown>,
    _agentRun?: string,
  ) => {
    throw FAKE_MEMORY_ERROR;
  },
}));

// ---------------------------------------------------------------------------
// Mock K8s core() — returns a fake CoreV1Api that handles ConfigMap ops.
// ---------------------------------------------------------------------------

const mockConfigMaps = new Map<
  string,
  { name: string; namespace: string; data?: Record<string, string> }
>();

function createFakeCoreV1Api() {
  return {
    readNamespacedConfigMap: async ({ name, namespace }: { name: string; namespace: string }) => {
      const key = `${namespace}/${name}`;
      const cm = mockConfigMaps.get(key);
      if (!cm) throw Object.assign(new Error(`ConfigMap ${name} not found`), { statusCode: 404 });
      return cm as unknown as import('@kubernetes/client-node').V1ConfigMap;
    },
    patchNamespacedConfigMap: async ({
      name,
      namespace,
      body,
    }: {
      name: string;
      namespace: string;
      body: { data?: Record<string, string> };
    }) => {
      const key = `${namespace}/${name}`;
      let cm = mockConfigMaps.get(key);
      if (!cm) {
        cm = {
          name,
          namespace,
          data: {},
        } as unknown as import('@kubernetes/client-node').V1ConfigMap;
        mockConfigMaps.set(key, cm);
      }
      if (body.data) {
        cm.data = { ...cm.data, ...body.data };
      }
      return cm as unknown as import('@kubernetes/client-node').V1ConfigMap;
    },
  };
}

const fakeCoreApi = createFakeCoreV1Api();

mock.module('@percussionist/kube', () => ({
  readSessionConfigMap: async (runName: string, sessionID: string) => {
    const key = `percussionist/${runName}-session`;
    const cm = mockConfigMaps.get(key);
    if (!cm?.data) return null;

    // Check sessions.json for the session ID
    const sessionsRaw = cm.data['sessions.json'];
    if (!sessionsRaw) return null;
    const sessions: string[] = JSON.parse(sessionsRaw);
    if (!sessions.includes(sessionID)) return null;

    const raw = cm.data[`messages-${sessionID}.json`];
    if (!raw) return null;
    return {
      messages: JSON.parse(raw),
      truncated: cm.data?.[`truncated-${sessionID}`] === 'true',
    };
  },
  core: () => fakeCoreApi,
}));

// ---------------------------------------------------------------------------
// Import the module under test and override session functions directly
// via __sessionFns (mutable config object) instead of mock.module, which
// leaks globally across test files.
// ---------------------------------------------------------------------------

import { __sessionFns, summarizeSession } from '../session-summarizer.js';

__sessionFns.createSession = async (title: string) => `session-${title}`;
__sessionFns.sendPrompt = async (_sessionId: string, _prompt: string) => {
  /* no-op */
};
__sessionFns.waitForCompletion = async (_sessionId: string, _timeoutMs?: number) => {
  return 'This session accomplished feature implementation. Key decisions included choosing the memory-service architecture and implementing non-fatal degradation for store failures.';
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedConfigMap(runName: string, sessionID: string, messages: unknown[]) {
  const key = `percussionist/${runName}-session`;
  mockConfigMaps.set(key, {
    name: `${runName}-session`,
    namespace: 'percussionist',
    data: {
      [`sessions.json`]: JSON.stringify([sessionID]),
      [`messages-${sessionID}.json`]: JSON.stringify(messages),
    },
  });
}

function clearConfigMaps() {
  mockConfigMaps.clear();
}

// ---------------------------------------------------------------------------
// Tests — memory write failure observability and non-fatal degradation.
// ---------------------------------------------------------------------------

describe('summarizeSession — memory-write failure', () => {
  beforeEach(() => {
    clearConfigMaps();
  });

  afterEach(() => {
    clearConfigMaps();
  });

  it('succeeds despite storeMemory throwing (non-fatal degradation)', async () => {
    // Seed a valid session snapshot.
    seedConfigMap('plan-worker-1', 'sess-abc123', [
      {
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'Implement memory service integration.' }],
      },
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: 'Done. Added storeMemory, queryMemory, and getContext functions.' },
        ],
      },
    ]);

    // Capture console.error output to verify warning was logged.
    const originalErr = console.error;
    const errorLogs: string[] = [];
    console.error = (...args) => {
      errorLogs.push(args.map(String).join(' '));
    };

    try {
      await summarizeSession('test-project', 'plan-worker-1', 'sess-abc123', 'percussionist');
    } finally {
      console.error = originalErr;
    }

    // Summarization should succeed (no exception thrown).
    // The ConfigMap should have the summary stored.
    const cmKey = `percussionist/plan-worker-1-session`;
    const cm = mockConfigMaps.get(cmKey);
    expect(cm).toBeDefined();
    expect(cm!.data?.['summary-sess-abc123']).toBeDefined();
    expect(typeof cm!.data!['summary-sess-abc123']).toBe('string');
  });

  it('logs a warning containing project/run/session/error when storeMemory fails', async () => {
    seedConfigMap('build-worker-2', 'sess-def456', [
      {
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'Fix the memory client.' }],
      },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'Fixed. Added proper error handling.' }],
      },
    ]);

    const originalErr = console.error;
    const errorLogs: string[] = [];
    console.error = (...args) => {
      errorLogs.push(args.map(String).join(' '));
    };

    try {
      await summarizeSession('my-project', 'build-worker-2', 'sess-def456', 'percussionist');
    } finally {
      console.error = originalErr;
    }

    // Verify warning was logged with contextual identifiers.
    const memoryWarning = errorLogs.find(
      (log) =>
        log.includes('memory-store warning') &&
        log.includes('my-project') &&
        log.includes('build-worker-2') &&
        log.includes('sess-def456') &&
        log.includes(FAKE_MEMORY_ERROR.message),
    );
    expect(memoryWarning).toBeDefined();
  });

  it('does not rethrow storeMemory error — summarization path is independent', async () => {
    seedConfigMap('worker-3', 'sess-ghi789', [
      {
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'Write tests.' }],
      },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'Tests written and passing.' }],
      },
    ]);

    // Should not throw — storeMemory failure is non-fatal.
    await expect(
      summarizeSession('proj', 'worker-3', 'sess-ghi789', 'percussionist'),
    ).resolves.toBeUndefined();
  });

  it('idempotent: skips when summary already exists, no memory call attempted', async () => {
    // Pre-populate ConfigMap with existing summary.
    const key = `percussionist/plan-worker-1-session`;
    mockConfigMaps.set(key, {
      name: 'plan-worker-1-session',
      namespace: 'percussionist',
      data: {
        [`summary-sess-exists`]: 'existing summary content',
      },
    });

    // Capture both console.log and console.error to verify no errors.
    const originalLog = console.log;
    const originalErr = console.error;
    const logMessages: string[] = [];
    const errorLogs: string[] = [];
    console.log = (...args) => {
      logMessages.push(args.map(String).join(' '));
    };
    console.error = (...args) => {
      errorLogs.push(args.map(String).join(' '));
    };

    try {
      await summarizeSession('test-project', 'plan-worker-1', 'sess-exists', 'percussionist');
    } finally {
      console.log = originalLog;
      console.error = originalErr;
    }

    // Should log idempotent message (via console.log), not error.
    const idempotentLog = logMessages.find((log) => log.includes('idempotent'));
    expect(idempotentLog).toBeDefined();
    // No errors should be logged for idempotent skip.
    expect(errorLogs.length).toBe(0);
  });

  it('logs warning with error details when storeMemory throws', async () => {
    seedConfigMap('timeout-worker', 'sess-timeout1', [
      {
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'Test timeout handling.' }],
      },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'Timeout test passed.' }],
      },
    ]);

    const originalErr = console.error;
    const errorLogs: string[] = [];
    console.error = (...args) => {
      errorLogs.push(args.map(String).join(' '));
    };

    try {
      await summarizeSession('timeout-project', 'timeout-worker', 'sess-timeout1', 'percussionist');
    } finally {
      console.error = originalErr;
    }

    // Should still succeed and log warning with error details.
    const cmKey = `percussionist/timeout-worker-session`;
    const cm = mockConfigMaps.get(cmKey);
    expect(cm!.data?.['summary-sess-timeout1']).toBeDefined();

    // The warning should contain the project/run/session identifiers and error message.
    const memoryWarning = errorLogs.find(
      (log) =>
        log.includes('memory-store warning') &&
        log.includes('timeout-project') &&
        log.includes(FAKE_MEMORY_ERROR.message),
    );
    expect(memoryWarning).toBeDefined();
  });
});

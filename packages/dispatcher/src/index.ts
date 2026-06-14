// Dispatcher sidecar entrypoint.
//
// Runs alongside `opencode serve` inside an Run pod. Responsibilities:
//   1. Wait for the server to be reachable on 127.0.0.1:4096.
//   2. (prompt mode) Create a session, fire the task as a prompt (async).
//      (interactive mode) Wait for the user to start a session via the web UI
//      or `beatctl attach`; observe all sessions that appear.
//   3. Mirror session activity into the Run status subresource.
//   4. On completion, snapshot all sessions to a ConfigMap and send analytics.
// 5. Serve an MCP endpoint on 127.0.0.1:4097 so agents can call fail_run(),
//      complete_run(), complete_plan(), complete_merge(), complete_review(),
//      get_status(), create_task(), search_code(), read_session(), write_plan(),
//      and read_plan() without cluster API access.
//
// Environment (injected by the operator):
//   RUN_NAME, RUN_NAMESPACE, RUN_UID
//   OPENCODE_BASE_URL               — http://127.0.0.1:4096
//   RUN_TASK                        — the prompt text (prompt mode only)
//   RUN_MODEL                       — optional provider/model
//   RUN_AGENT                       — optional ClusterAgent name
//   RUN_INTERACTIVE                 — "1" for interactive mode
//   WEB_STATS_URL                   — optional analytics endpoint

import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
} from '@kubernetes/client-node';
import { API_GROUP, API_VERSION, PLURAL_RUN, RunPhase, type RunStatus } from '@percussionist/api';
import { startMcpServer } from './mcp-server.js';
import { runInteractive, runPrompt, snapshotAllSessions } from './polling.js';
import { waitForHealthy } from './session.js';
import { sendStats } from './stats-reporter.js';

const env = (k: string, required = true): string => {
  const v = process.env[k];
  if (!v && required) {
    console.error(`[dispatcher] missing required env: ${k}`);
    process.exit(2);
  }
  return v ?? '';
};

const RUN_NAME = env('RUN_NAME');
const RUN_NAMESPACE = env('RUN_NAMESPACE');
const RUN_UID = env('RUN_UID');
const INTERACTIVE = env('RUN_INTERACTIVE', false) === '1';
env('RUN_TASK', !INTERACTIVE); // validate required in prompt mode

const log = (...args: unknown[]) =>
  console.log(`[dispatcher ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[dispatcher ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// Graceful shutdown

let shuttingDown = false;
const shutdownSignalled = new Promise<void>((resolve) => {
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    resolve();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
});

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    shutdownSignalled.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// K8s client + status patching

const kc = new KubeConfig();
kc.loadFromDefault();
const k8s = kc.makeApiClient(CustomObjectsApi);
const coreApi = kc.makeApiClient(CoreV1Api);

async function patchStatus(patch: RunStatus): Promise<void> {
  const body = { status: { ...patch, lastEventAt: new Date().toISOString() } };
  try {
    await k8s.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace: RUN_NAMESPACE,
        plural: PLURAL_RUN,
        name: RUN_NAME,
        body,
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  } catch (e) {
    err('patchStatus failed:', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Module-level state for error handler

let _activeSessionID: string | undefined;
let _runStartedAt: string | undefined;
let _lastStatus: { phase: string; session?: string; tokensIn?: number; tokensOut?: number } | null =
  null;

function wrapPatchStatus(fn: typeof patchStatus) {
  return async (patch: RunStatus): Promise<void> => {
    await fn(patch);
    _lastStatus = {
      phase: patch.phase ?? _lastStatus?.phase ?? 'unknown',
      session: patch.sessionID ?? _activeSessionID ?? _lastStatus?.session,
      tokensIn: patch.tokensIn ?? _lastStatus?.tokensIn,
      tokensOut: patch.tokensOut ?? _lastStatus?.tokensOut,
    };
  };
}

// ---------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  // Start the MCP server immediately so MCP tools are
  // available as soon as opencode accepts connections.
  let resolveFailure!: (reason: string) => void;
  const failureSignal = new Promise<string>((resolve) => {
    resolveFailure = resolve;
  });
  let failureSignalled = false;

  let resolveCompletion!: (summary: string) => void;
  const completionSignal = new Promise<string>((resolve) => {
    resolveCompletion = resolve;
  });
  let completionSignalled = false;

  let resolvePlan!: (summary: string) => void;
  const planSignal = new Promise<string>((resolve) => {
    resolvePlan = resolve;
  });
  let planSignalled = false;

  const patchedPatchStatus = wrapPatchStatus(patchStatus);

  const mcp = await startMcpServer(
    (reason) => {
      if (failureSignalled) return;
      failureSignalled = true;
      log(`fail_run called by agent: ${reason}`);
      resolveFailure(reason);
    },
    (summary) => {
      if (completionSignalled) return;
      completionSignalled = true;
      resolveCompletion(summary);
    },
    (summary) => {
      if (planSignalled) return;
      planSignalled = true;
      log(`complete_plan called by agent: ${summary}`);
      resolvePlan(summary);
    },
    () => _lastStatus,
  );
  log('MCP server listening on 127.0.0.1:4097');

  try {
    await patchedPatchStatus({ phase: RunPhase.Initializing, message: 'waiting for opencode' });
    await waitForHealthy(120_000, () => shuttingDown, interruptibleSleep);

    if (INTERACTIVE) {
      await runInteractive(
        patchedPatchStatus,
        () => shuttingDown,
        interruptibleSleep,
        coreApi,
        RUN_NAME,
        RUN_NAMESPACE,
        RUN_UID,
      );
    } else {
      const result = await runPrompt(
        patchedPatchStatus,
        () => shuttingDown,
        interruptibleSleep,
        coreApi,
        RUN_NAME,
        RUN_NAMESPACE,
        RUN_UID,
        failureSignal,
        completionSignal,
        planSignal,
      );
      _activeSessionID = result.sessionID;
      _runStartedAt = result.startedAt;
    }
  } finally {
    mcp.close();
  }
}

main().catch(async (e) => {
  if (shuttingDown) {
    log('shutdown in progress; suppressing fatal:', (e as Error).message ?? e);
    process.exit(0);
  }
  const msg = String((e as Error).message ?? e);
  // Last-resort safety net: if an aborted-message error reaches here, keep
  // the run in Running phase instead of failing it — the abort was not a
  // run failure, just the user pressing "cancel".
  if (
    msg.includes('MessageAbortedError') ||
    msg.includes('AbortError') ||
    msg.includes('Aborted')
  ) {
    log('message aborted (caught in main().catch) — exiting cleanly');
    const completedAt = new Date().toISOString();
    if (_activeSessionID) {
      await snapshotAllSessions(coreApi, RUN_NAME, RUN_NAMESPACE, RUN_UID, _activeSessionID).catch(
        () => {},
      );
      await sendStats(
        _activeSessionID,
        RunPhase.Running,
        _runStartedAt ?? completedAt,
        completedAt,
        {
          tokensIn: 0,
          tokensOut: 0,
          tokensReasoning: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          cost: 0,
        },
        'message aborted',
      ).catch(() => {});
    }
    await patchStatus({
      phase: RunPhase.Running,
      message: 'waiting for input (message aborted)',
      completedAt,
    }).catch(() => {});
    process.exit(0);
  }
  err('fatal:', e);
  const completedAt = new Date().toISOString();
  // Best-effort snapshot so session data survives fatal errors (e.g. waitForHealthy timeout).
  if (_activeSessionID) {
    await snapshotAllSessions(coreApi, RUN_NAME, RUN_NAMESPACE, RUN_UID, _activeSessionID).catch(
      () => {
        /* best effort */
      },
    );
  }
  if (_activeSessionID) {
    await sendStats(
      _activeSessionID,
      RunPhase.Failed,
      _runStartedAt ?? completedAt,
      completedAt,
      {
        tokensIn: 0,
        tokensOut: 0,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        cost: 0,
      },
      msg,
    ).catch(() => {
      /* best effort */
    });
  }
  try {
    await patchStatus({
      phase: RunPhase.Failed,
      message: msg,
      completedAt,
    });
  } catch {
    /* best effort */
  }
  process.exit(1);
});

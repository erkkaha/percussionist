import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import { core, readSessionConfigMap } from '@percussionist/kube';
import { storeMemory } from './agent/memory-client.js';
import {
  createSession as _createSession,
  sendPrompt as _sendPrompt,
  waitForCompletion as _waitForCompletion,
} from './agent/session.js';

// Overridable function references — allows tests to inject mocks without
// global module-level mocking that leaks across test files.
export const __sessionFns = {
  createSession: _createSession,
  sendPrompt: _sendPrompt,
  waitForCompletion: _waitForCompletion,
};

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';

const MAX_SUMMARY_CHARS = 16_000;
const MAX_INPUT_CHARS = 60_000;
const SNAPSHOT_RETRY_MAX = 3;
const SNAPSHOT_RETRY_BASE_MS = 500;

const log = (...args: unknown[]) =>
  console.log(`[session-summarizer ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[session-summarizer ${new Date().toISOString()}]`, ...args);

export async function summarizeSession(
  project: string,
  runName: string,
  sessionID: string,
  namespace: string = NAMESPACE,
): Promise<void> {
  try {
    // -----------------------------------------------------------------------
    // Idempotency check before any expensive work.
    // -----------------------------------------------------------------------
    let existingSummary: string | undefined;
    try {
      const cm = await core().readNamespacedConfigMap({
        name: `${runName}-session`,
        namespace,
      });
      existingSummary = cm.data?.[`summary-${sessionID}`];
    } catch {
      // ConfigMap not found — will be created fresh.
    }
    if (existingSummary) {
      log(
        `idempotent: summary already exists for ${project}/${runName}/${sessionID} (${existingSummary.length} chars)`,
      );
      return;
    }

    // -----------------------------------------------------------------------
    // Bounded retry loop for snapshot read — the dispatcher writes the
    // messages ConfigMap asynchronously, so it may not be ready yet.
    // -----------------------------------------------------------------------
    const snapshot = await readSessionConfigMapWithRetry(runName, sessionID, namespace);
    if (!snapshot) {
      err(
        `snapshot unavailable after ${SNAPSHOT_RETRY_MAX} retries — skipping summarization for ${project}/${runName}/${sessionID}`,
      );
      return;
    }

    const compactMessages = compactSessionForSummary(snapshot.messages);
    if (!compactMessages) {
      log(`no meaningful messages in ${project}/${runName}/${sessionID}`);
      return;
    }

    const summary = await produceSummary(compactMessages);
    if (!summary) {
      log(`summarization returned empty for ${project}/${runName}/${sessionID}`);
      return;
    }

    const truncated = summary.slice(0, MAX_SUMMARY_CHARS);

    // -----------------------------------------------------------------------
    // Persist to ConfigMap — only emit success log after confirmed write.
    // -----------------------------------------------------------------------
    try {
      await core().patchNamespacedConfigMap(
        {
          name: `${runName}-session`,
          namespace,
          body: {
            data: { [`summary-${sessionID}`]: truncated },
          },
        },
        setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
      );
    } catch (e) {
      err(`ConfigMap patch failed for ${project}/${runName}/${sessionID}: ${(e as Error).message}`);
      return;
    }

    log(
      `stored summary for ${project}/${runName}/${sessionID} (${truncated.length} chars, truncated=${summary.length > MAX_SUMMARY_CHARS})`,
    );

    storeMemory(
      project,
      truncated,
      {
        type: 'session-summary',
        runName,
        sessionID,
      },
      `run:${runName}`,
    ).catch((e) => {
      err(`memory-store warning for ${project}/${runName}/${sessionID}: ${(e as Error).message}`);
    });
  } catch (e) {
    err(`summarizeSession error for ${project}/${runName}/${sessionID}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Snapshot read with bounded retry + exponential backoff.
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSessionConfigMapWithRetry(
  runName: string,
  sessionID: string,
  namespace: string = NAMESPACE,
): Promise<{ messages: unknown[]; truncated: boolean } | null> {
  for (let attempt = 1; attempt <= SNAPSHOT_RETRY_MAX; attempt++) {
    const snapshot = await readSessionConfigMap(runName, sessionID, namespace);
    if (snapshot) return snapshot;

    if (attempt < SNAPSHOT_RETRY_MAX) {
      const backoffMs = SNAPSHOT_RETRY_BASE_MS * 2 ** (attempt - 1);
      log(
        `snapshot not ready for ${runName}/${sessionID}, attempt ${attempt}/${SNAPSHOT_RETRY_MAX}, retrying in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    } else {
      err(
        `snapshot still missing after ${SNAPSHOT_RETRY_MAX} attempts for ${runName}/${sessionID}`,
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers

function compactSessionForSummary(rawMessages: unknown[]): string | null {
  const parts: string[] = [];
  let total = 0;

  for (const msg of rawMessages) {
    const m = msg as {
      info?: { role?: string };
      parts?: Array<{ type: string; text?: string }>;
    };
    const role = m.info?.role ?? 'unknown';
    const textParts: string[] = [];

    for (const part of m.parts ?? []) {
      if (part.type === 'text' && part.text) {
        const trimmed = part.text.slice(0, 2000);
        textParts.push(trimmed);
      }
    }

    if (textParts.length === 0) continue;

    const line = `[${role.toUpperCase()}]\n${textParts.join('\n')}`;
    if (total + line.length > MAX_INPUT_CHARS) {
      parts.push('[...remaining messages truncated...]');
      break;
    }
    parts.push(line);
    total += line.length;
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

async function produceSummary(sessionText: string): Promise<string | null> {
  const summarizationPrompt = [
    'You are a summarization assistant. Summarize the following agent session in 2-3 paragraphs.',
    'Focus on: what was accomplished, what decisions were made, what obstacles were encountered, and any unfinished work.',
    'Be concise and factual. This summary will be used as context for future runs.',
    '',
    'SESSION:',
    sessionText,
  ].join('\n');

  let sessionId: string;
  try {
    sessionId = await __sessionFns.createSession('session-summarizer', 'manager-decision');
  } catch {
    err('failed to create summarization session');
    return null;
  }

  try {
    await __sessionFns.sendPrompt(sessionId, summarizationPrompt, 'manager-decision');
    const result = await __sessionFns.waitForCompletion(sessionId, 120_000);
    return result;
  } catch (e) {
    err('summarization LLM call failed:', (e as Error).message);
    return null;
  }
}

import { readSessionConfigMap, core } from "@percussionist/kube";
import { createSession, sendPrompt, waitForCompletion } from "./agent/session.js";
import { storeMemory } from "./agent/memory-client.js";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";

const MAX_SUMMARY_CHARS = 16_000;
const MAX_INPUT_CHARS = 60_000;

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
    const snapshot = await readSessionConfigMap(runName, sessionID, namespace);
    if (!snapshot) {
      log(`no ConfigMap snapshot for ${runName}/${sessionID}`);
      return;
    }

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
      log(`summary already exists for ${runName}/${sessionID}`);
      return;
    }

    const compactMessages = compactSessionForSummary(snapshot.messages);
    if (!compactMessages) {
      log(`no meaningful messages in ${runName}/${sessionID}`);
      return;
    }

    const summary = await produceSummary(compactMessages);
    if (!summary) {
      log(`summarization returned empty for ${runName}/${sessionID}`);
      return;
    }

    const truncated = summary.slice(0, MAX_SUMMARY_CHARS);

    try {
      await core().patchNamespacedConfigMap(
        {
          name: `${runName}-session`,
          namespace,
          body: {
            data: { [`summary-${sessionID}`]: truncated },
          },
        },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
    } catch {
      // ConfigMap not found or gone — best effort.
    }

    log(`stored summary for ${runName}/${sessionID} (${truncated.length} chars)`);

    storeMemory(project, truncated, {
      type: "session-summary",
      runName,
      sessionID,
    }, `run:${runName}`).catch(() => {});
  } catch (e) {
    err(`summarizeSession error for ${runName}/${sessionID}:`, (e as Error).message);
  }
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
    const role = m.info?.role ?? "unknown";
    const textParts: string[] = [];

    for (const part of m.parts ?? []) {
      if (part.type === "text" && part.text) {
        const trimmed = part.text.slice(0, 2000);
        textParts.push(trimmed);
      }
    }

    if (textParts.length === 0) continue;

    const line = `[${role.toUpperCase()}]\n${textParts.join("\n")}`;
    if (total + line.length > MAX_INPUT_CHARS) {
      parts.push("[...remaining messages truncated...]");
      break;
    }
    parts.push(line);
    total += line.length;
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

async function produceSummary(sessionText: string): Promise<string | null> {
  const summarizationPrompt = [
    "You are a summarization assistant. Summarize the following agent session in 2-3 paragraphs.",
    "Focus on: what was accomplished, what decisions were made, what obstacles were encountered, and any unfinished work.",
    "Be concise and factual. This summary will be used as context for future runs.",
    "",
    "SESSION:",
    sessionText,
  ].join("\n");

  let sessionId: string;
  try {
    sessionId = await createSession("session-summarizer", "manager-decision");
  } catch {
    err("failed to create summarization session");
    return null;
  }

  try {
    await sendPrompt(sessionId, summarizationPrompt, "manager-decision");
    const result = await waitForCompletion(sessionId, 120_000);
    return result;
  } catch (e) {
    err("summarization LLM call failed:", (e as Error).message);
    return null;
  }
}

// lib/run-summary.ts — pure, framework-free derivation of a concise run summary.
//
// A summary is a *derived view*, never persisted: purpose and latest activity
// are recomputed from structured facts (the resolved related task, the first
// prompt line, spec.interactive, status phases/timestamps, and structured
// session tool parts) every time it is read. No LLM output or model prose is
// ever used as summary text, which keeps the result reproducible and makes it
// exhaustively unit-testable.
//
// The server exposes the *facts* (`relatedTask`, a bounded `taskPreview`,
// `interactive`, status fields); this module turns those facts plus the session
// messages into the view model shared by the run list and the run detail page.

import type { SessionMessage, ToolPart } from './types';

export type RunPurposeKind = 'task' | 'prompt' | 'interactive' | 'none';
export type RunMode = 'interactive' | 'automated';

/**
 * Minimal structural view of a Run. The full Run CR (detail route) and the
 * stripped list projection both fit; only the summary-relevant fields are
 * declared so the helper stays decoupled from either shape.
 */
export interface RunSummarySpec {
  task?: string | null;
  taskPreview?: string | null;
  interactive?: boolean | null;
  boardTask?: string | null;
  project?: string | null;
}

export interface RunSummaryStatus {
  phase?: string | null;
  message?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastEventAt?: string | null;
}

export interface RunSummaryRunLike {
  spec?: RunSummarySpec | null;
  status?: RunSummaryStatus | null;
}

/**
 * The task a run is linked to, as projected by the server from
 * `run.spec.boardTask`. Omitted when the Task CR is gone (deleted).
 */
export interface RunSummaryRelatedTask {
  name: string;
  title: string;
  type: string;
  phase?: string | null;
}

export interface RunSummary {
  /** False only for the explicit "no purpose source" state. */
  hasSummary: boolean;
  purpose: string | null;
  purposeKind: RunPurposeKind;
  mode: RunMode;
  /** Single-line activity phrase; never raw model prose. */
  activity: string;
  /** Epoch-ms timestamp of the activity's source, or null when nothing is timed. */
  activityAt: number | null;
  /** True when an active run has had no event inside the freshness window. */
  activityIsStale: boolean;
}

export interface DeriveRunSummaryInput {
  run: RunSummaryRunLike;
  relatedTask?: RunSummaryRelatedTask | null;
  sessionMessages?: SessionMessage[];
  /** Epoch ms — injected so derivation stays pure and tests are deterministic. */
  now: number;
}

const PURPOSE_MAX = 120;
const ACTIVITY_MAX = 100;
const FAIL_MESSAGE_MAX = 80;
const STATUS_MESSAGE_MAX = 80;
const MINUTE_MS = 60_000;
const STALE_MS = 5 * MINUTE_MS;

const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Cancelled']);

// ---------------------------------------------------------------------------
// Small text utilities

/** Collapse all whitespace runs (including newlines) to single spaces. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate to `max` chars, ending with an ellipsis when shortened. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+$/, '')}…`;
}

/** First line with non-whitespace content, or null. */
function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) return line;
  }
  return null;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** Path basename across both POSIX and Windows separators. */
function basename(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

function firstString(input: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function parseTime(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function messageTime(message: SessionMessage | undefined): number | undefined {
  const created = message?.info?.time?.created;
  return typeof created === 'number' && Number.isFinite(created) ? created : undefined;
}

function formatDuration(start: number | undefined, end: number | undefined): string | null {
  if (start === undefined || end === undefined || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * A status message is only surfaced verbatim when it reads like a short human
 * phrase — never monospace internals (paths, `KEY=value`, container noise).
 */
function isShortNonTechnical(text: string): boolean {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length === 0 || collapsed.length > STATUS_MESSAGE_MAX) return false;
  return !collapsed.includes('/') && !collapsed.includes('\\') && !collapsed.includes('=');
}

// ---------------------------------------------------------------------------
// Purpose

function filePhrase(verb: string, input: Record<string, unknown> | undefined): string {
  const path = firstString(input, ['filePath', 'file_path', 'path', 'filename', 'file']);
  const base = path ? basename(path) : null;
  return base ? `${verb} ${base}` : `${verb} a file`;
}

function commandPhrase(input: Record<string, unknown> | undefined): string {
  const command = firstString(input, ['command', 'cmd']);
  if (!command) return 'Running a command';
  const tokens = collapseWhitespace(command).split(' ').filter(Boolean);
  const first = tokens[0];
  if (!first) return 'Running a command';
  return tokens.length > 1 ? `Running ${first} …` : `Running ${first}`;
}

/**
 * Map one structured tool part to a short "verb object" phrase.
 *
 * Covers both opencode and claude runner tool names (the claude runner
 * normalises PascalCase names to lowercase before emitting parts). Structured
 * `state.input` is the source — `state.title` is runner-generated text and is
 * deliberately never used here, so an assistant message's prose can never leak
 * into the activity line.
 */
export function summarizeToolPart(part: ToolPart): string {
  const tool = (part.tool ?? '').toLowerCase();
  const input = part.state?.input;
  switch (tool) {
    case 'read':
    case 'read_file':
      return filePhrase('Reading', input);
    case 'edit':
    case 'write':
    case 'patch':
    case 'apply_patch':
      return filePhrase('Editing', input);
    case 'bash':
    case 'shell':
      return commandPhrase(input);
    case 'grep':
    case 'glob':
    case 'search':
    case 'codebase_search':
      return 'Searching the workspace';
    case 'write_plan':
    case 'read_plan':
      return 'Working on the plan';
    case 'todowrite':
    case 'task':
      return 'Updating the task list';
    case 'fetch':
    case 'webfetch':
      return 'Fetching a URL';
    default:
      return `Using ${part.tool}`;
  }
}

/**
 * Purpose priority: resolved task → first prompt line → interactive → none.
 * A deleted task (no `relatedTask`) simply falls through to the next source.
 */
export function deriveRunPurpose(
  run: RunSummaryRunLike,
  relatedTask?: RunSummaryRelatedTask | null,
): { purpose: string | null; purposeKind: RunPurposeKind } {
  if (relatedTask) {
    const title = firstNonEmptyString(relatedTask.title);
    if (title) {
      const type = firstNonEmptyString(relatedTask.type);
      const purpose = type ? `${type} · ${collapseWhitespace(title)}` : collapseWhitespace(title);
      return { purpose: truncate(collapseWhitespace(purpose), PURPOSE_MAX), purposeKind: 'task' };
    }
  }

  const prompt = firstNonEmptyString(run.spec?.taskPreview, run.spec?.task);
  if (prompt) {
    const line = firstNonEmptyLine(prompt);
    if (line) {
      const text = collapseWhitespace(line.replace(/^TASK:\s*/i, ''));
      if (text) return { purpose: truncate(text, PURPOSE_MAX), purposeKind: 'prompt' };
    }
  }

  if (run.spec?.interactive === true) {
    return { purpose: 'Interactive session', purposeKind: 'interactive' };
  }

  return { purpose: null, purposeKind: 'none' };
}

// ---------------------------------------------------------------------------
// Activity

function phaseVerb(phase: string | null | undefined): string {
  switch (phase) {
    case 'Pending':
      return 'Starting up';
    case 'Initializing':
      return 'Initializing workspace';
    case 'WaitingForInput':
      return 'Waiting for your input';
    default:
      return 'Working';
  }
}

function finalizeActive(
  activity: string,
  activityAt: number | undefined,
  hasObservedActivity: boolean,
  now: number,
): { activity: string; activityAt: number | null; activityIsStale: boolean } {
  let text = truncate(collapseWhitespace(activity), ACTIVITY_MAX);
  let stale = false;
  if (activityAt !== undefined && now - activityAt > STALE_MS) {
    const minutes = Math.floor((now - activityAt) / MINUTE_MS);
    text = hasObservedActivity
      ? `${text} (no activity for ${minutes}m)`
      : `No activity for ${minutes}m`;
    stale = true;
  }
  return { activity: text, activityAt: activityAt ?? null, activityIsStale: stale };
}

/**
 * Derive the latest deterministic activity for a run.
 *
 * Terminal runs get a completion phrase, never an in-progress verb. Active runs
 * look for the last structured tool part in the newest session message; failing
 * that they fall back to the newest message's role, then to the run phase.
 */
export function deriveLatestActivity(
  run: RunSummaryRunLike,
  sessionMessages: SessionMessage[] = [],
  now: number,
): { activity: string; activityAt: number | null; activityIsStale: boolean } {
  const status = run.status ?? {};
  const phase = status.phase ?? null;

  if (phase !== null && TERMINAL_PHASES.has(phase)) {
    const completedAt = parseTime(status.completedAt);
    const lastEventAt = parseTime(status.lastEventAt);
    const startedAt = parseTime(status.startedAt);
    const activityAt = completedAt ?? lastEventAt ?? startedAt;

    let activity: string;
    if (phase === 'Succeeded') {
      const duration = formatDuration(startedAt, completedAt ?? lastEventAt);
      activity = duration ? `Completed in ${duration}` : 'Completed';
    } else if (phase === 'Failed') {
      const message = firstNonEmptyString(status.message);
      activity = message
        ? `Failed — ${truncate(collapseWhitespace(message), FAIL_MESSAGE_MAX)}`
        : 'Failed';
    } else {
      activity = 'Cancelled';
    }

    return {
      activity: truncate(collapseWhitespace(activity), ACTIVITY_MAX),
      activityAt: activityAt ?? null,
      activityIsStale: false,
    };
  }

  const newest = sessionMessages[sessionMessages.length - 1];
  if (newest) {
    const parts = newest.parts ?? [];
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part?.type === 'tool') {
        return finalizeActive(
          summarizeToolPart(part as ToolPart),
          messageTime(newest) ?? parseTime(status.lastEventAt) ?? parseTime(status.startedAt),
          true,
          now,
        );
      }
    }

    const activity = newest.info?.role === 'user' ? 'Awaiting agent response' : 'Thinking…';
    return finalizeActive(
      activity,
      messageTime(newest) ?? parseTime(status.lastEventAt) ?? parseTime(status.startedAt),
      true,
      now,
    );
  }

  // No session messages yet — an explicit wait state, a trustworthy short
  // status message, or a generic phase verb.
  if (phase === 'WaitingForInput') {
    return finalizeActive(
      'Waiting for your input',
      parseTime(status.lastEventAt) ?? parseTime(status.startedAt),
      parseTime(status.lastEventAt) !== undefined,
      now,
    );
  }

  const message = firstNonEmptyString(status.message);
  if (message && isShortNonTechnical(message)) {
    return finalizeActive(
      collapseWhitespace(message),
      parseTime(status.lastEventAt) ?? parseTime(status.startedAt),
      true,
      now,
    );
  }

  const lastEventAt = parseTime(status.lastEventAt);
  return finalizeActive(
    phaseVerb(phase),
    lastEventAt ?? parseTime(status.startedAt),
    lastEventAt !== undefined,
    now,
  );
}

// ---------------------------------------------------------------------------
// Top-level

/**
 * Derive the shared run summary view model. Pure: identical inputs always
 * produce an identical result, and nothing here reads model prose.
 */
export function deriveRunSummary(input: DeriveRunSummaryInput): RunSummary {
  const { run, relatedTask, sessionMessages = [], now } = input;
  const { purpose, purposeKind } = deriveRunPurpose(run, relatedTask);
  const activity = deriveLatestActivity(run, sessionMessages, now);
  return {
    hasSummary: purposeKind !== 'none',
    purpose,
    purposeKind,
    mode: run.spec?.interactive === true ? 'interactive' : 'automated',
    ...activity,
  };
}

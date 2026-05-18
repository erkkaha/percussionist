// lib/types.ts — re-exports from @percussionist/api plus client-only types.
//
// Zod is not run in the browser. These are TypeScript-only structural types
// derived from the server schema, plus a few client-specific view models.

// Re-export server types so components import from a single place.
export type {
  Run,
  Project,
  Task,
  ClusterAgent,
  BoardStatus,
  ManagerMetrics,
  WorkerStatus,
  TaskColumn,
  TaskType,
} from "@percussionist/api";
export { RunPhase, TERMINAL_PHASES } from "@percussionist/api";

import type { Project as _Project } from "@percussionist/api";

/** GET /api/projects/:name augments the CR with inject file contents for UI pre-population. */
export interface ProjectDetail extends _Project {
  injectFileContents?: Array<{ filename: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Run creation request (sent to POST /api/runs)

export interface AgentDef {
  name: string;
  content: string;
}

export interface CreateRunRequest {
  task?: string;
  interactive?: boolean;
  agent?: string;
  /** Inline agent defs (name + markdown content). Sent as spec.inlineAgents. */
  inlineAgents?: AgentDef[];
  model?: string;
  /** Required — project name for config resolution and provenance. */
  project: string;
  source?: {
    git?: {
      url: string;
      ref?: string;
      sshSecret?: { name: string; key?: string };
      githubTokenSecret?: { name: string; key?: string };
      author?: { name: string; email: string };
    };
  };
  secrets?: {
    llmKeysSecret?: string;
    authSecret?: { name: string; key?: string };
  };
  timeoutSeconds?: number;
  name?: string;
}

// ---------------------------------------------------------------------------
// Project creation / update request

export interface CreateProjectRequest {
  name?: string;
  displayName?: string;
  model?: string;
  agent?: string;
  /** Inline opencode.json content — stored as a per-project ConfigMap. */
  opencodeConfig?: string;
  secrets?: {
    llmKeysSecret?: string;
    authSecret?: { name: string; key?: string };
  };
  source?: {
    git?: {
      url: string;
      ref?: string;
      sshSecret?: { name: string; key?: string };
      githubTokenSecret?: { name: string; key?: string };
      author?: { name: string; email: string };
    };
  };
  /** Project-level sidecars injected into every run pod. */
  sidecars?: Array<{
    name: string;
    image: string;
    env?: Array<{ name: string; value: string }>;
    ports?: number[];
  }>;
  /** Files to inject into /workspace/<filename> — content managed server-side as K8s Secrets. */
  injectFiles?: Array<{ filename: string; content: string }>;
  /** Shell script to run after git clone, before opencode starts. */
  initScript?: string;
  /** Team roster: ClusterAgent names available to this project's tasks. */
  agents?: Array<{ name: string }>;
}

export interface CreateAgentRequest {
  name?: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Logs

export interface LogsResponse {
  podName: string;
  container: string;
  lines: string;
}

// ---------------------------------------------------------------------------
// Session messages (from OpenCode API inside run pods)

export interface TextPart {
  id: string;
  messageID: string;
  type: "text";
  text: string;
}

export interface ToolPart {
  id: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: {
    status: "pending" | "running" | "completed" | "error";
    input: Record<string, unknown>;
    output?: string;
    title?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    time?: { start: number; end?: number };
  };
}

export interface ReasoningPart {
  id: string;
  messageID: string;
  type: "reasoning";
  text: string;
}

export interface StepStartPart {
  id: string;
  messageID: string;
  type: "step-start";
}

export interface StepFinishPart {
  id: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  tokens: { input: number; output: number; reasoning: number };
}

export interface SubtaskPart {
  id: string;
  messageID: string;
  type: "subtask";
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
    priority: "high" | "medium" | "low";
  }>;
}

export interface FilePart {
  id: string;
  messageID: string;
  type: "file";
  filename: string;
  path?: string;
  diff?: string;
  beforeContent?: string;
  afterContent?: string;
}

export type SessionPart =
  | TextPart
  | ToolPart
  | ReasoningPart
  | StepStartPart
  | StepFinishPart
  | SubtaskPart
  | FilePart
  | { id: string; messageID: string; type: string; [key: string]: unknown };

export interface SessionMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  tokens?: { input: number; output: number; reasoning: number };
  error?: { name: string; message: string };
  agent?: string;
  modelID?: string;
  providerID?: string;
}

export interface SessionMessage {
  info: SessionMessageInfo;
  parts: SessionPart[];
}

export interface SessionResponse {
  sessionID: string;
  messages: SessionMessage[];
  source?: "live" | "snapshot";
  truncated?: boolean;
}

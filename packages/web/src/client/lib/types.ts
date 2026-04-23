// Client-side types mirroring the OpenCodeRun CRD shape returned by the API.
// We keep these light — no Zod on the client, just TypeScript interfaces.

export interface OpenCodeRunCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface OpenCodeRunStatus {
  phase?: RunPhase;
  message?: string;
  podName?: string;
  serviceName?: string;
  sessionID?: string;
  startedAt?: string;
  completedAt?: string;
  lastEventAt?: string;
  tokensIn?: number;
  tokensOut?: number;
  webURL?: string;
  ingressName?: string;
  conditions?: OpenCodeRunCondition[];
}

export interface GitSource {
  url: string;
  ref?: string;
  sshSecret?: { name: string; key: string };
}

export interface OpenCodeRunSpec {
  task?: string;
  interactive: boolean;
  agent?: string;
  model?: string;
  image: string;
  source?: { git?: GitSource };
  timeoutSeconds: number;
  ttlSecondsAfterFinished: number;
}

export interface OpenCodeRun {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    [key: string]: unknown;
  };
  spec: OpenCodeRunSpec;
  status?: OpenCodeRunStatus;
}

export type RunPhase =
  | "Pending"
  | "Initializing"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Cancelled";

export const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set([
  "Succeeded",
  "Failed",
  "Cancelled",
]);

export interface LogsResponse {
  podName: string;
  container: string;
  lines: string;
}

export interface CreateRunRequest {
  /** Prompt for the agent. Required unless interactive is true. */
  task?: string;
  interactive?: boolean;
  agent?: string;
  model?: string;
  /** Git source for /workspace. */
  source?: {
    git?: {
      url: string;
      ref?: string;
    };
  };
  /** Seconds before the run is killed. Default 3600. */
  timeoutSeconds?: number;
  /** Optional custom name (auto-generated if absent). */
  name?: string;
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
  tokens: {
    input: number;
    output: number;
    reasoning: number;
  };
}

export type SessionPart = TextPart | ToolPart | ReasoningPart | StepStartPart | StepFinishPart | {
  id: string;
  messageID: string;
  type: string;
  [key: string]: unknown;
};

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
  /** "live" = proxied from the running pod; "snapshot" = read from ConfigMap. */
  source?: "live" | "snapshot";
  /** True when the ConfigMap snapshot was truncated to fit under 1 MiB. */
  truncated?: boolean;
}

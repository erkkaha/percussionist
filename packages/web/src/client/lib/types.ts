// lib/types.ts — re-exports from @percussionist/api plus client-only types.
//
// Zod is not run in the browser. These are TypeScript-only structural types
// derived from the server schema, plus a few client-specific view models.

// Re-export server types so components import from a single place.
import type {
  AgentCapability,
  BoardStatus,
  ClusterAgent,
  DiffContext,
  DiffFinding,
  DiffFindingSeverity,
  DiffLineAnchor,
  Finding,
  ManagerMetrics,
  Project,
  Run,
  TaskColumn,
  TaskDiffFindings,
  TaskType,
  WorkerStatus,
} from '@percussionist/api';

export type {
  AgentCapability,
  BoardStatus,
  ClusterAgent,
  DiffContext,
  DiffFinding,
  DiffFindingSeverity,
  DiffLineAnchor,
  Finding,
  ManagerMetrics,
  Project,
  Run,
  TaskColumn,
  TaskDiffFindings,
  TaskType,
  WorkerStatus,
} from '@percussionist/api';
export { RunPhase, TERMINAL_PHASES } from '@percussionist/api';

import type { Project as _Project, Task as _Task } from '@percussionist/api';

/** GET /api/projects/:name augments the CR with inject file contents for UI pre-population. */
export interface ProjectDetail extends _Project {
  injectFileContents?: Array<{ filename: string; content: string }>;
}

/**
 * GET /api/projects and GET /api/projects/:name may include a computed
 * codeServerUrl when ClusterSettings.spec.codeServerUrlTemplate is configured.
 */
export interface ProjectWithCodeServerUrl extends _Project {
  codeServerUrl?: string;
}

/** Tasks in board responses may include computed child progress for awaiting-children phase. */
export interface Task extends _Task {
  displayRefs?: {
    parentTask?: string | null;
    parentTaskCanonical?: string | null;
    predecessorTask?: string | null;
    predecessorTaskCanonical?: string | null;
  };
  childProgress?: {
    total: number;
    completed: number;
    childRefs: string[];
    childDisplayRefs?: string[];
  };
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
    local?: boolean;
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
  /** Maximum number of concurrently running tasks. */
  maxParallel?: number;
  /** Run timeout in seconds. */
  timeoutSeconds?: number;
  /** Enable per-task feature branches to prevent git mirror conflicts. */
  featureBranchingEnabled?: boolean;

  /** Auto-retry policy for failed tasks. */
  retryPolicy?: {
    enabled?: boolean;
    maxAttempts?: number;
    backoffSeconds?: number;
    backoffMultiplier?: number;
    maxBackoffSeconds?: number;
    poisonPillThresholdSeconds?: number;
  };

  /** Automated review policy for completed tasks. */
  reviewPolicy?: {
    aiReviewerEnabled?: boolean;
    aiReviewerAgent?: string;
    maxAutoReworks?: number;
  };

  /** Project-level runner image override. */
  image?: string;

  /** Pod resource requirements at project level. */
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };

  /** Alpine packages installed in every run pod at initialization. */
  runner?: {
    packages?: string[];
  };

  /** Board lifecycle phase: Active / Complete / Archived. */
  phase?: 'Active' | 'Complete' | 'Archived';

  /** Git workspace caching and persistence options. */
  gitCache?: {
    worktreeReuse?: boolean;
  };

  /** Task lifecycle presets and overrides. */
  flow?: {
    preset?: 'simple' | 'review' | 'plan-build' | 'plan-build-review-merge';
    humanApproval?: {
      plan?: 'required' | 'disabled';
      build?: 'required' | 'disabled';
    };
    plan?: {
      onApprove?: 'generate-builds' | 'done';
      buildGeneration?: 'ai' | 'manual' | 'disabled';
    };
    build?: {
      onSuccess?: 'human-review' | 'ai-review' | 'done';
      onApprove?: 'merge' | 'done';
    };
    merge?: {
      mode?: 'auto' | 'manual' | 'disabled';
    };
    review?: {
      aiReviewerEnabled?: boolean;
      aiReviewerAgent?: string;
      maxAutoReworks?: number;
    };
    retry?: {
      enabled?: boolean;
      maxAttempts?: number;
      backoffSeconds?: number;
      backoffMultiplier?: number;
      maxBackoffSeconds?: number;
      poisonPillThresholdSeconds?: number;
    };
    timeouts?: {
      runningStaleSeconds?: number;
      reviewStaleSeconds?: number;
      mergeStaleSeconds?: number;
      buildgenStaleSeconds?: number;
    };
  };

  /** Per-project code-server for interactive workspace access. */
  codeServer?: {
    enabled?: boolean;
    image?: string;
    resources?: {
      requests?: Record<string, string>;
      limits?: Record<string, string>;
    };
  };

  /** Data PVC configuration — shared cache, git mirrors and worktrees. */
  data?: {
    pvcName?: string;
    mountPath?: string;
    storageClass?: string;
  };

  /** Per-project memory service with vector embeddings for agent context/memory. */
  embedding?: {
    enabled?: boolean;
    model?: string;
    dimensions?: number;
    ollamaUrl?: string;
  };

  /** Exec/maintenance pod configuration — controls the container image used for workspace exec pods. */
  exec?: {
    image?: string;
  };
}

export interface CreateAgentRequest {
  name?: string;
  content: string;
  model?: string;
  capabilities?: AgentCapability[];
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
  type: 'text';
  text: string;
}

export interface ToolPart {
  id: string;
  messageID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
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
  type: 'reasoning';
  text: string;
}

export interface StepStartPart {
  id: string;
  messageID: string;
  type: 'step-start';
}

export interface StepFinishPart {
  id: string;
  messageID: string;
  type: 'step-finish';
  reason: string;
  tokens: { input: number; output: number; reasoning: number };
  cost?: number;
}

export interface SubtaskPart {
  id: string;
  messageID: string;
  type: 'subtask';
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    priority: 'high' | 'medium' | 'low';
  }>;
}

export interface FilePart {
  id: string;
  messageID: string;
  type: 'file';
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
  role: 'user' | 'assistant';
  time: { created: number; completed?: number };
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache?: { read: number; write: number };
  };
  cost?: number;
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
  source?: 'live' | 'snapshot';
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Plan response (from GET /api/projects/:project/plans/:taskId)

export interface PlanResponse {
  content: string;
  taskId: string;
  project: string;
}

export interface TaskDiffFile {
  path: string;
  diff: string;
}

export interface DiffCommit {
  sha: string;
  subject: string;
  body: string;
  files: TaskDiffFile[];
}

/** A stored diff finding projected against the current diff context. */
export interface TaskDiffFinding extends DiffFinding {
  isActive: boolean;
  isStale: boolean;
}

export interface TaskDiffResponse {
  project: string;
  task: string;
  defaultRef: string;
  baseRef: string;
  headRef: string;
  /** Resolved commit SHA for the base ref. */
  baseSha: string;
  /** Resolved commit SHA for the head ref. */
  headSha: string;
  /** Merge-base commit SHA between base and head. */
  forkSha: string;
  /** Deterministic SHA-256 fingerprint of fork/head/file patch identity. */
  diffFingerprint: string;
  /** Current diff context used for staleness checks. */
  context: DiffContext;
  files: TaskDiffFile[];
  /** Stored findings with active/stale status against the current context. */
  findings: TaskDiffFinding[];
  commits?: DiffCommit[];
  empty: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Project memories (proxy through web server → memory service)

/** A single stored memory record with its embedding distance (0 for non-search results). */
export interface ProjectMemory {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  /** Cosine distance from search query; always 0 for list/get operations. */
  distance: number;
  createdAt: string | null;
}

/** GET /api/projects/:name/memories response with pagination metadata. */
export interface ListMemoriesResponse {
  memories: ProjectMemory[];
  total: number;
}

/** POST /api/projects/:name/memories request body. */
export interface CreateMemoryRequest {
  content: string;
  metadata?: Record<string, unknown>;
  agentRun?: string;
}

/** PATCH /api/projects/:name/memories/:id request body (partial update). */
export interface UpdateMemoryRequest {
  content?: string;
  metadata?: Record<string, unknown>;
}

/** POST /api/projects/:name/memories response — returns the created memory ID. */
export interface CreateMemoryResponse {
  id: string;
}

/** DELETE /api/projects/:name/memories/:id response. */
export interface DeleteMemoryResponse {
  deleted: true;
}

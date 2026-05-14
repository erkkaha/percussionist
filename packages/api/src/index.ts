// Percussionist API — Zod schemas are the single source of truth.
//
// CRD YAML in crds/ is generated from these schemas via `pnpm run codegen`
// in the scripts/ package. When they disagree the Zod definition wins at
// admission time inside the operator.
//
// Three CRDs:
//   ClusterAgent       — cluster-scoped agent role definitions
//   OpenCodeProject    — namespace-scoped project config + embedded kanban board
//   OpenCodeRun        — namespace-scoped task execution

import { z } from "zod";

// ---------------------------------------------------------------------------
// API constants

export const API_GROUP = "percussionist.dev";
export const API_VERSION = "v1alpha1";
export const API_GROUP_VERSION = `${API_GROUP}/${API_VERSION}`;
export const KIND_RUN = "OpenCodeRun";
export const PLURAL_RUN = "opencoderuns";
export const KIND_PROJECT = "OpenCodeProject";
export const PLURAL_PROJECT = "opencodeprojects";
export const KIND_CLUSTER_AGENT = "ClusterAgent";
export const PLURAL_CLUSTER_AGENT = "clusteragents";

// ---------------------------------------------------------------------------
// Shared building blocks

export const ResourceRequirementsSchema = z
  .object({
    requests: z.record(z.string()).optional(),
    limits: z.record(z.string()).optional(),
  })
  .partial();

export type ResourceRequirements = z.infer<typeof ResourceRequirementsSchema>;

export const SecretsRefSchema = z
  .object({
    // All keys in this Secret are exposed as environment variables verbatim
    // (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    llmKeysSecret: z.string().optional(),

    // Reference to a Secret whose `key` holds opencode's auth.json.
    // Projected as OPENCODE_AUTH_CONTENT env var into the runner.
    opencodeAuthSecret: z
      .object({
        name: z.string().min(1),
        key: z.string().default("auth.json"),
      })
      .optional(),

    // Reference to a ConfigMap whose `key` holds an opencode.json config.
    // Projected as OPENCODE_CONFIG_CONTENT env var into the runner.
    opencodeConfigMap: z
      .object({
        name: z.string().min(1),
        key: z.string().default("opencode.json"),
      })
      .optional(),
  })
  .partial();

export type SecretsRef = z.infer<typeof SecretsRefSchema>;

export const GitSourceSchema = z.object({
  url: z.string().min(1),
  ref: z.string().optional(),
  sshSecret: z
    .object({
      name: z.string().min(1),
      key: z.string().default("ssh-privatekey"),
    })
    .optional(),
  // Reference to a Secret whose `key` holds a GitHub personal access token
  // (or fine-grained token). When set, the operator mounts the token into the
  // runner and authenticates `gh` CLI so it can create PRs, manage issues, etc.
  githubTokenSecret: z
    .object({
      name: z.string().min(1),
      key: z.string().default("token"),
    })
    .optional(),
  author: z
    .object({
      name: z.string().min(1),
      email: z.string().min(1),
    })
    .optional(),
});

export type GitSource = z.infer<typeof GitSourceSchema>;

export const SourceSchema = z.object({
  git: GitSourceSchema.optional(),
});

export const ExposeSchema = z
  .object({
    web: z.boolean().default(true),
  })
  .partial();

// A sidecar container that runs alongside the opencode runner in every pod for
// a given project. Useful for services the agent needs during its task, e.g. a
// test database. The agent reaches them via localhost.
// A reference to a file to inject into the runner pod at /workspace/<filename>.
// The file content is stored in a K8s Secret and mounted via subPath.
export const InjectFileRefSchema = z.object({
  // Filename only (no path separators). The file will be mounted at
  // /workspace/<filename> inside the runner container.
  filename: z.string().min(1).max(255).regex(/^[^/]+$/, "filename must not contain path separators"),

  // Reference to a K8s Secret holding the file content.
  secretRef: z.object({
    name: z.string().min(1),
    // Key within the Secret whose value is the raw file content.
    key: z.string().default("content"),
  }),
});

export type InjectFileRef = z.infer<typeof InjectFileRefSchema>;

export const SidecarSpecSchema = z.object({
  // Must be a valid RFC 1123 DNS label (K8s container name rules).
  name: z.string().min(1).max(63),
  image: z.string().min(1),
  // Environment variables injected into the sidecar container.
  env: z
    .array(z.object({ name: z.string().min(1), value: z.string() }))
    .max(32)
    .optional(),
  // TCP ports the sidecar listens on. The operator will wait for all of these
  // to be reachable on localhost before starting opencode.
  ports: z.array(z.number().int().min(1).max(65535)).max(8).optional(),
});

export type SidecarSpec = z.infer<typeof SidecarSpecSchema>;

// A reference to a ClusterAgent by name.
export const AgentRefSchema = z.object({
  name: z.string().min(1).max(63),
});

export type AgentRef = z.infer<typeof AgentRefSchema>;

// Inline agent definition — kept for CLI escape hatch (--inline-agent flag),
// not surfaced in the UI. Use ClusterAgents for persistent agent definitions.
export const AgentDefSchema = z.object({
  name: z.string().min(1).max(63),
  content: z.string().max(102400),
});

export type AgentDef = z.infer<typeof AgentDefSchema>;

// ---------------------------------------------------------------------------
// ClusterAgent — cluster-scoped catalog of reusable agent role definitions.

export const ClusterAgentSpecSchema = z.object({
  // Full .md file contents (YAML front-matter + system prompt). Max 100KB.
  content: z.string().max(102400),
});

export type ClusterAgentSpec = z.infer<typeof ClusterAgentSpecSchema>;

export const ClusterAgentSchema = z.object({
  apiVersion: z.literal(API_GROUP_VERSION),
  kind: z.literal(KIND_CLUSTER_AGENT),
  metadata: z
    .object({
      name: z.string(),
      uid: z.string().optional(),
      resourceVersion: z.string().optional(),
      labels: z.record(z.string()).optional(),
      annotations: z.record(z.string()).optional(),
      creationTimestamp: z.string().optional(),
      deletionTimestamp: z.string().optional(),
    })
    .passthrough(),
  spec: ClusterAgentSpecSchema,
});

export type ClusterAgent = z.infer<typeof ClusterAgentSchema>;

// ---------------------------------------------------------------------------
// Facilitation types — must come before OpenCodeRunSpec which references them.

export const FacilitationAction = {
  RetrySame: "retry_same",
  RetryAlternative: "retry_alternative",
  Skip: "skip",
  Approve: "approve",
  Escalate: "escalate",
} as const;
export type FacilitationAction =
  (typeof FacilitationAction)[keyof typeof FacilitationAction];

export const FacilitationSpecSchema = z.object({
  targetRunName: z.string().min(1),
  targetTaskId: z.string().min(1),
  failureReason: z.string().max(8192),
  sessionSummary: z.string().max(32768),
  // When true this facilitation run is reviewing a successful run (not a failure).
  successReview: z.boolean().default(false),
});

export type FacilitationSpec = z.infer<typeof FacilitationSpecSchema>;

export const FacilitationResultSchema = z.object({
  diagnosis: z.string().max(1024),
  recommendedAction: z.enum([
    FacilitationAction.RetrySame,
    FacilitationAction.RetryAlternative,
    FacilitationAction.Skip,
    FacilitationAction.Approve,
    FacilitationAction.Escalate,
  ]),
  alternativeAgent: z.string().max(63).optional(),
  suggestion: z.string().max(4096).optional(),
});

export type FacilitationResult = z.infer<typeof FacilitationResultSchema>;

// ---------------------------------------------------------------------------
// OpenCodeRun — the core CRD reconciled by the operator.

export const OpenCodeRunSpecSchema = z
  .object({
    // Required: references an OpenCodeProject in the same namespace.
    // Provides provenance and is used to resolve defaults at creation time.
    project: z.string().min(1),

    // Set by manager-controller when this run was spawned by a board task.
    boardTask: z.string().optional(),

    // What the agent should do. Required unless interactive: true.
    task: z.string().min(1).optional(),

    // When true the dispatcher skips auto-prompt; user drives via beatctl attach.
    interactive: z.boolean().default(false),

    // Primary agent — references a ClusterAgent by name.
    agent: z.string().optional(),

    // Additional ClusterAgent refs available in the pod.
    agents: AgentRefSchema.array().max(10).optional(),

    // Facilitation spec — set when this run is a facilitator analyzing a failed task.
    facilitation: FacilitationSpecSchema.optional(),

    // Inline agent defs for CLI escape hatch (--inline-agent). Not in UI.
    inlineAgents: AgentDefSchema.array().max(5).optional(),

    model: z.string().optional(),
    image: z.string().default("percussionist/runner:dev"),
    resources: ResourceRequirementsSchema.optional(),
    secrets: SecretsRefSchema.optional(),
    source: SourceSchema.optional(),
    // Sidecar containers injected into the pod alongside the opencode runner.
    // Resolved from the parent OpenCodeProject at creation time.
    // opencode will not start until all declared sidecar ports are reachable.
    sidecars: SidecarSpecSchema.array().max(5).optional(),

    // Files to inject into /workspace/<filename> inside the runner container.
    // Content is stored in K8s Secrets and mounted via subPath volumes.
    injectFiles: InjectFileRefSchema.array().max(20).optional(),

    timeoutSeconds: z.number().int().positive().default(3600),
    ttlSecondsAfterFinished: z.number().int().nonnegative().default(3600),
    expose: ExposeSchema.optional(),
  })
  .refine((s) => s.interactive || !!s.task, {
    message: "spec.task is required unless spec.interactive is true",
    path: ["task"],
  });

export type OpenCodeRunSpec = z.infer<typeof OpenCodeRunSpecSchema>;

export const RunPhase = {
  Pending: "Pending",
  Initializing: "Initializing",
  Running: "Running",
  WaitingForInput: "WaitingForInput",
  Succeeded: "Succeeded",
  Failed: "Failed",
  Cancelled: "Cancelled",
} as const;
export type RunPhase = (typeof RunPhase)[keyof typeof RunPhase];

export const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set([
  RunPhase.Succeeded,
  RunPhase.Failed,
  RunPhase.Cancelled,
]);

export const OpenCodeRunStatusSchema = z
  .object({
    phase: z.enum([
      RunPhase.Pending,
      RunPhase.Initializing,
      RunPhase.Running,
      RunPhase.WaitingForInput,
      RunPhase.Succeeded,
      RunPhase.Failed,
      RunPhase.Cancelled,
    ]),
    message: z.string().optional(),
    podName: z.string().optional(),
    serviceName: z.string().optional(),
    sessionID: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    lastEventAt: z.string().optional(),
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    webURL: z.string().optional(),
    ingressName: z.string().optional(),
    conditions: z
      .array(
        z.object({
          type: z.string(),
          status: z.enum(["True", "False", "Unknown"]),
          reason: z.string().optional(),
          message: z.string().optional(),
          lastTransitionTime: z.string().optional(),
        }),
      )
      .optional(),
  })
  .partial();

export type OpenCodeRunStatus = z.infer<typeof OpenCodeRunStatusSchema>;

export const OpenCodeRunSchema = z.object({
  apiVersion: z.literal(API_GROUP_VERSION),
  kind: z.literal(KIND_RUN),
  metadata: z
    .object({
      name: z.string(),
      namespace: z.string().optional(),
      uid: z.string().optional(),
      resourceVersion: z.string().optional(),
      generation: z.number().optional(),
      labels: z.record(z.string()).optional(),
      annotations: z.record(z.string()).optional(),
      creationTimestamp: z.string().optional(),
      deletionTimestamp: z.string().optional(),
      finalizers: z.array(z.string()).optional(),
      ownerReferences: z
        .array(
          z.object({
            apiVersion: z.string(),
            kind: z.string(),
            name: z.string(),
            uid: z.string(),
            controller: z.boolean().optional(),
            blockOwnerDeletion: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .passthrough(),
  spec: OpenCodeRunSpecSchema,
  status: OpenCodeRunStatusSchema.optional(),
});

export type OpenCodeRun = z.infer<typeof OpenCodeRunSchema>;

// ---------------------------------------------------------------------------
// OpenCodeProject — project config + embedded kanban board.
//
// The board is auto-created (empty) when the project is created.
// The manager-controller watches projects and drives the board lifecycle.

// Task type enum
export const TaskType = {
  Plan: "PLAN",
  Build: "BUILD",
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

// A task on the board.
export const BoardTaskSchema = z.object({
  // Unique identifier (e.g. "PLAN-1", "BUILD-5"). Immutable once created.
  id: z.string().min(1).max(32),

  // Task type - PLAN or BUILD.
  type: z.enum(["PLAN", "BUILD"]),

  // Short human-readable title shown on the task card.
  title: z.string().min(1).max(256),

  // Detailed context + acceptance criteria sent to the worker agent.
  description: z.string().max(8192).optional(),

  // Priority for ordering within a column.
  priority: z.enum(["high", "medium", "low"]).default("medium"),

  // Required: which ClusterAgent from board.agents[] handles this task.
  agent: z.string().min(1),
});

export type BoardTask = z.infer<typeof BoardTaskSchema>;

// Per-worker execution tracking in board status.
export const WorkerStatusSchema = z.object({
  taskId: z.string().min(1),
  runName: z.string().optional(),
  status: z.enum(["Running", "Succeeded", "Failed", "Escalated"]),
  branch: z.string().optional(),
  prNumber: z.number().int().min(1).optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  escalation: z.string().max(4096).optional(),
  retryCount: z.number().int().min(0).default(0),
  facilitated: z.boolean().default(false),
  facilitationRunName: z.string().optional(),
  // Name of the success-review facilitator run (set after worker Succeeded).
  reviewRunName: z.string().optional(),
  facilitationResult: FacilitationResultSchema.optional(),
  // BUILD task generation tracking (for PLAN tasks).
  buildTasksFacilitatorRun: z.string().optional(),
  buildTasksCreated: z.boolean().optional(),
  createdBuildTasks: z.array(z.string()).optional(),
});

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const PendingQuestionSchema = z.object({
  workerId: z.string(),
  sessionID: z.string(),
  messageText: z.string().max(16384),
});

export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

// Board spec — embedded in OpenCodeProject.
export const BoardSpecSchema = z.object({
  // WIP limit: max concurrent worker runs. Default 2.
  maxParallel: z.number().int().min(1).max(20).default(2),

  // Team roster: which ClusterAgents are available to this board.
  // Task.agent must reference a name from this list.
  agents: AgentRefSchema.array().optional(),

  // The task backlog. Placement in columns is tracked in status.board.
  tasks: BoardTaskSchema.array().max(100).optional(),

  // Overrides for project-level defaults applied to all worker runs.
  overrides: z
    .object({
      model: z.string().optional(),
      image: z.string().optional(),
      timeoutSeconds: z.number().int().positive().optional(),
      resources: ResourceRequirementsSchema.optional(),
    })
    .optional(),

  // Board lifecycle.
  phase: z.enum(["Active", "Complete", "Archived"]).default("Active"),
});

export type BoardSpec = z.infer<typeof BoardSpecSchema>;

// Manager reconciliation metrics — written by manager-controller on each cycle.
export const ManagerMetricsSchema = z.object({
  /** When the most recent reconcile cycle started (ISO string). */
  lastReconcileAt: z.string().optional(),
  /** Duration of the last reconcile in milliseconds. */
  lastReconcileDurationMs: z.number().int().nonnegative().optional(),
  /** Result of the last reconcile: "success", "error", or undefined if never reconciled. */
  lastReconcileResult: z.enum(["success", "error"]).optional(),
  /** Error message from the last failed reconcile (if any). */
  lastError: z.string().optional(),
  /** Number of tasks pulled from ready this cycle. */
  tasksPulled: z.number().int().nonnegative().default(0),
  /** Number of workers monitored this cycle. */
  workersMonitored: z.number().int().nonnegative().default(0),
  /** Number of tasks re-dispatched this cycle. */
  tasksReworked: z.number().int().nonnegative().default(0),
});

export type ManagerMetrics = z.infer<typeof ManagerMetricsSchema>;

// Board status — tracked by manager-controller.
export const BoardStatusSchema = z.object({
  columns: z
    .string()
    .array()
    .default(["ready", "in-progress", "review", "rework", "done"]),
  backlog: z.record(z.string().array()).default({ ready: [] }),
  workers: WorkerStatusSchema.array().default([]),
  activeWorkers: z.number().int().min(0).default(0),
  // Task ID sequence counters per type (PLAN, BUILD).
  sequences: z.record(z.number().int().min(0)).optional(),
  escalations: z.string().array().optional(),
  pendingQuestions: PendingQuestionSchema.array().optional(),
  facilitations: FacilitationResultSchema.array().optional(),
  lastEventAt: z.string().optional(),
  /** Manager reconciliation metrics — written by manager-controller. */
  managerMetrics: ManagerMetricsSchema.optional(),
});

export type BoardStatus = z.infer<typeof BoardStatusSchema>;

// OpenCodeProject spec.
export const OpenCodeProjectSpecSchema = z.object({
  // Human-readable label for the UI. Falls back to metadata.name.
  displayName: z.string().optional(),

  // Git workspace — cloned by all runs and board workers for this project.
  source: SourceSchema.optional(),

  // Secrets inherited by all runs and board workers for this project.
  secrets: SecretsRefSchema.optional(),

  // Default model for runs and board workers.
  model: z.string().optional(),

  // Default agent for runs and board workers.
  agent: z.string().optional(),

  // Default runner image.
  image: z.string().optional(),

  // Default run timeout in seconds. Defaults to 3600.
  timeoutSeconds: z.number().int().positive().default(3600),

  // Default pod resource requirements.
  resources: ResourceRequirementsSchema.optional(),

  // Sidecar containers injected into every run pod for this project.
  // Useful for test databases, mock servers, etc. The agent reaches them via
  // localhost. opencode will not start until all declared sidecar ports are
  // reachable.
  sidecars: SidecarSpecSchema.array().max(5).optional(),

  // Files to inject into /workspace/<filename> inside the runner container.
  // Content is stored in K8s Secrets and mounted via subPath volumes.
  injectFiles: InjectFileRefSchema.array().max(20).optional(),

  // Embedded kanban board configuration.
  board: BoardSpecSchema.optional(),
});

export type OpenCodeProjectSpec = z.infer<typeof OpenCodeProjectSpecSchema>;

// OpenCodeProject status.
export const OpenCodeProjectStatusSchema = z.object({
  // Embedded board operational state.
  board: BoardStatusSchema.optional(),
});

export type OpenCodeProjectStatus = z.infer<typeof OpenCodeProjectStatusSchema>;

export const OpenCodeProjectSchema = z.object({
  apiVersion: z.literal(API_GROUP_VERSION),
  kind: z.literal(KIND_PROJECT),
  metadata: z
    .object({
      name: z.string(),
      namespace: z.string().optional(),
      uid: z.string().optional(),
      resourceVersion: z.string().optional(),
      generation: z.number().optional(),
      labels: z.record(z.string()).optional(),
      annotations: z.record(z.string()).optional(),
      creationTimestamp: z.string().optional(),
      deletionTimestamp: z.string().optional(),
    })
    .passthrough(),
  spec: OpenCodeProjectSpecSchema,
  status: OpenCodeProjectStatusSchema.optional(),
});

export type OpenCodeProject = z.infer<typeof OpenCodeProjectSchema>;

// ---------------------------------------------------------------------------
// Well-known label/annotation keys and container naming.

export const LABELS = {
  managedBy: "app.kubernetes.io/managed-by",
  component: "percussionist.dev/component",
  runName: "percussionist.dev/run",
  projectName: "percussionist.dev/project",
  taskId: "percussionist.dev/task-id",
} as const;

export const MANAGED_BY = "percussionist";

export const CONTAINER_PORT = 4096;
// MCP server port served by the dispatcher sidecar. Chosen to be adjacent to
// CONTAINER_PORT and unlikely to clash with common development tooling.
export const DISPATCHER_MCP_PORT = 4097;
export const RUNNER_CONTAINER = "opencode";
export const DISPATCHER_CONTAINER = "dispatcher";
export const GIT_CLONE_CONTAINER = "git-clone";

// ---------------------------------------------------------------------------
// Config resolution helpers.
//
// Resolves the effective run config by merging project defaults,
// board overrides (if kanban-spawned), and explicit run-level values.
// Called at creation time in CLI and manager-controller.

export interface ResolvedRunConfig {
  model?: string;
  image: string;
  timeoutSeconds: number;
  resources?: ResourceRequirements;
  secrets?: SecretsRef;
  source?: { git?: GitSource };
  sidecars?: SidecarSpec[];
  injectFiles?: InjectFileRef[];
}

export function resolveRunConfig(
  project: OpenCodeProjectSpec,
  boardOverrides?: BoardSpec["overrides"],
  runOverrides?: Partial<ResolvedRunConfig>,
): ResolvedRunConfig {
  return {
    model:
      runOverrides?.model ??
      boardOverrides?.model ??
      project.model,
    image:
      runOverrides?.image ??
      boardOverrides?.image ??
      project.image ??
      "percussionist/runner:dev",
    timeoutSeconds:
      runOverrides?.timeoutSeconds ??
      boardOverrides?.timeoutSeconds ??
      project.timeoutSeconds ??
      3600,
    resources:
      runOverrides?.resources ??
      boardOverrides?.resources ??
      project.resources,
    secrets: project.secrets,
    source: project.source,
    sidecars: project.sidecars,
    injectFiles: project.injectFiles,
  };
}
// Percussionist API — Zod schemas are the single source of truth.
//
// CRD YAML in crds/ is generated from these schemas via `pnpm run codegen`
// in the scripts/ package. When they disagree the Zod definition wins at
// admission time inside the operator.
//
// Five CRDs:
//   ClusterAgent       — cluster-scoped agent role definitions
//   ClusterSettings    — cluster-wide singleton for global configuration
//   Project            — namespace-scoped project config + settings
//   Task               — namespace-scoped task (PLAN or BUILD), references a project
//   Run                — namespace-scoped task execution

import { z } from "zod";

// ---------------------------------------------------------------------------
// API constants

export const API_GROUP = "percussionist.dev";
export const API_VERSION = "v1alpha1";
export const API_GROUP_VERSION = `${API_GROUP}/${API_VERSION}`;
export const KIND_RUN = "Run";
export const PLURAL_RUN = "runs";
export const KIND_PROJECT = "Project";
export const PLURAL_PROJECT = "projects";
export const KIND_TASK = "Task";
export const PLURAL_TASK = "tasks";
export const KIND_CLUSTER_AGENT = "ClusterAgent";
export const PLURAL_CLUSTER_AGENT = "clusteragents";
export const KIND_CLUSTER_SETTINGS = "ClusterSettings";
export const PLURAL_CLUSTER_SETTINGS = "clustersettings";

// ---------------------------------------------------------------------------
// Runner adapter interface
// ---------------------------------------------------------------------------
// Runner image / runtime spec
//
// Describes how the operator should launch the runner container.
// Set as ClusterSettings.spec.runnerAdapter to override the opencode defaults.

export interface RunnerImageSpec {
  /** Container image. Defaults to ghcr.io/anomalyco/opencode:latest */
  image: string;
  /** HTTP port the runner listens on. Defaults to 4096. */
  port: number;
  /** Command to launch the runner. Defaults to ["opencode","web","--hostname","0.0.0.0","--port","<port>"]. */
  command?: string[];
  /** Env var name for the auth blob. Defaults to OPENCODE_AUTH_CONTENT. */
  authEnvVar: string;
  /** Env var name for the config blob. Defaults to OPENCODE_CONFIG_CONTENT. */
  configEnvVar: string;
  /** Env var name passed to the dispatcher. Defaults to OPENCODE_BASE_URL. */
  baseUrlEnvVar: string;
  /** Absolute path inside the container where config is mounted. Defaults to /root/.config/opencode. */
  configMountPath: string;
  /** Relative path under configMountPath for agents dir. Defaults to agents. */
  agentsDirRelative: string;
  /** Name of the ConfigMap key that holds the runner config JSON. Defaults to opencode.json. */
  configMapKey: string;
}

// ---------------------------------------------------------------------------
// Runner tool packages
//
// System packages (apk) installed into every run pod for this project.
// Declared at the project level, inherited by all runs.

export const RunnerPackagesSchema = z.object({
  packages: z.array(z.string()).max(50).optional(),
}).optional();
export type RunnerPackages = z.infer<typeof RunnerPackagesSchema>;

/** Default RunnerImageSpec — points at the opencode runtime. */
export const OPENCODE_RUNNER_DEFAULTS: RunnerImageSpec = {
  image: "ghcr.io/anomalyco/opencode:latest",
  port: 4096,
  authEnvVar: "OPENCODE_AUTH_CONTENT",
  configEnvVar: "OPENCODE_CONFIG_CONTENT",
  baseUrlEnvVar: "OPENCODE_BASE_URL",
  configMountPath: "/root/.config/opencode",
  agentsDirRelative: "agents",
  configMapKey: "opencode.json",
};

// ---------------------------------------------------------------------------
// Shared building blocks
//
// DEPRECATED: The secrets schema is kept for backwards compatibility.
// All secrets are now managed at the cluster level via ClusterSettings.
// Project-level secrets are ignored — use ClusterSettings instead.

export const ResourceRequirementsSchema = z
  .object({
    requests: z.record(z.string()).optional(),
    limits: z.record(z.string()).optional(),
  })
  .partial();

export type ResourceRequirements = z.infer<typeof ResourceRequirementsSchema>;

// Code-server configuration for interactive workspace access.
export const CodeServerSpecSchema = z.object({
  /** Enable per-project code-server for interactive workspace access. */
  enabled: z.boolean().default(false),
  /** code-server container image. */
  image: z.string().default("codercom/code-server:4.96.4"),
  /** Pod resource requirements for code-server container. */
  resources: ResourceRequirementsSchema.optional(),
});
export type CodeServerSpec = z.infer<typeof CodeServerSpecSchema>;

export const MEMORY_SERVICE_PORT = 4100;
export const MEMORY_SERVICE_DEFAULT_IMAGE = "ghcr.io/erkkaha/percussionist/memory:latest";

// Embedding / vector memory configuration for per-project memory service.
export const EmbeddingSpecSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default("nomic-embed-text"),
  dimensions: z.number().int().default(768),
  ollamaUrl: z.string().optional(),
  resources: ResourceRequirementsSchema.optional(),
});
export type EmbeddingSpec = z.infer<typeof EmbeddingSpecSchema>;

// DEPRECATED — cluster-level secrets are managed via ClusterSettings.
// This schema is kept for backwards compatibility only.
export const SecretsRefSchema = z
  .object({
    // All keys in this Secret are exposed as environment variables verbatim
    // (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    llmKeysSecret: z.string().optional(),

    // Reference to a Secret whose `key` holds opencode's auth.json.
    // Projected as OPENCODE_AUTH_CONTENT env var into the runner.
    authSecret: z
      .object({
        name: z.string().min(1),
        key: z.string().default("auth.json"),
      })
      .optional(),

    // Reference to a ConfigMap whose `key` holds an opencode.json config.
    // Projected as OPENCODE_CONFIG_CONTENT env var into the runner.
    configMap: z
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
  // Parent ref for feature branching — when creating a new branch, create it from this ref.
  // Used by workspace-init when gitBranch doesn't exist yet.
  parentRef: z.string().optional(),
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

export const SourceSchema = z
  .object({
    git: GitSourceSchema.optional(),
    // When true, no remote is cloned. The workspace is initialised with
    // `git init` on first use and persisted in the project data PVC at
    // /data/workspace/.  Mutually exclusive with source.git.
    local: z.boolean().optional(),
  })
  .refine((s) => !(s.git && s.local), {
    message: "source.git and source.local are mutually exclusive",
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
  // Security context for the sidecar container (e.g. privileged mode for DinD).
  securityContext: z
    .object({
      privileged: z.boolean().optional(),
      runAsUser: z.number().int().optional(),
      runAsGroup: z.number().int().optional(),
      allowPrivilegeEscalation: z.boolean().optional(),
    })
    .optional(),
});

export type SidecarSpec = z.infer<typeof SidecarSpecSchema>;

// A reference to a ClusterAgent by name.
// Optional `model` overrides the project-level default for this agent specifically.
export const AgentRefSchema = z.object({
  name: z.string().min(1).max(63),
  model: z.string().optional(),
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
  // Optional model override for runs using this agent. Resolved between board and project level.
  model: z.string().optional(),
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
// ClusterSettings — cluster-wide singleton for global configuration.
//
// There is only one instance, named "default". It replaces the manually-managed
// opencode-config and agent-config ConfigMaps with a typed, validated CR that
// the operator reconciles into those ConfigMaps.
//
// Resolution order for any run:
//   Run.spec  →  Project.spec (maxParallel/agents overrides)  →  Project.spec  →  ClusterSettings.spec

export const ClusterSettingsSpecSchema = z.object({
  secrets: SecretsRefSchema.optional(),

  runnerConfig: z
    .object({
      config: z.string().optional(),
      configMapRef: z
        .object({
          name: z.string().min(1),
          key: z.string().default("opencode.json"),
        })
        .optional(),
    })
    .optional(),

  manager: z
    .object({
      agentName: z.string().default("manager-agent"),
      model: z.string().optional(),
      decisionAgentContent: z.string().max(102400).optional(),
      timeoutMs: z.number().int().positive().default(30000),
      firstResponseTimeoutMs: z.number().int().positive().optional(),
    })
    .optional(),

  runner: z
    .object({
      image: z.string().default("ghcr.io/erkkaha/percussionist/runner:latest"),
      timeoutSeconds: z.number().int().positive().default(3600),
      resources: ResourceRequirementsSchema.optional(),
    })
    .optional(),

  // How many days to keep completed Run CRs before automatic cleanup.
  runTTLDays: z.number().int().positive().default(7),

  // Optional override for the dispatcher sidecar image injected into run pods.
  // When absent, the operator's DISPATCHER_IMAGE env var is used as fallback.
  dispatcher: z
    .object({
      image: z.string().optional(),
    })
    .optional(),

  // Optional override for the runner container image / runtime spec.
  // When absent, the opencode defaults (OPENCODE_RUNNER_DEFAULTS) are used.
  runnerAdapter: z
    .object({
      image: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      command: z.array(z.string()).optional(),
      authEnvVar: z.string().optional(),
      configEnvVar: z.string().optional(),
      baseUrlEnvVar: z.string().optional(),
      configMountPath: z.string().optional(),
      agentsDirRelative: z.string().optional(),
      configMapKey: z.string().optional(),
    })
    .optional(),
});

export type ClusterSettingsSpec = z.infer<typeof ClusterSettingsSpecSchema>;

export const ClusterSettingsSchema = z.object({
  apiVersion: z.literal(API_GROUP_VERSION),
  kind: z.literal(KIND_CLUSTER_SETTINGS),
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
  spec: ClusterSettingsSpecSchema,
});

export type ClusterSettings = z.infer<typeof ClusterSettingsSchema>;

// ---------------------------------------------------------------------------
// Facilitation types — must come before OpenCodeRunSpec which references them.

export const FacilitationAction = {
  RetrySame: "retry_same",
  RetryAlternative: "retry_alternative",
  Skip: "skip",
  Approve: "approve",
  RequestChanges: "request_changes",
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
    FacilitationAction.RequestChanges,
    FacilitationAction.Escalate,
  ]),
  alternativeAgent: z.string().max(63).optional(),
  suggestion: z.string().max(4096).optional(),
});

export type FacilitationResult = z.infer<typeof FacilitationResultSchema>;

// ---------------------------------------------------------------------------
// Run — the core CRD reconciled by the operator.

export const RunSpecSchema = z
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
    image: z.string().default("ghcr.io/erkkaha/percussionist/runner:latest"),
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

  // Shell script to run after git clone completes, before opencode starts.
  // Inherited from the parent OpenCodeProject at creation time.
  initScript: z.string().optional(),

    timeoutSeconds: z.number().int().positive().default(3600),
    ttlSecondsAfterFinished: z.number().int().nonnegative().default(7 * 86400),
    expose: ExposeSchema.optional(),

    // Data PVC configuration — backs package manager caches, git mirrors,
    // worktrees, and local workspaces for the project.
    data: z
      .object({
        pvcName: z.string().optional(),    // defaults to `{project}-data`
        mountPath: z.string().default("/data"),
        storageClass: z.string().optional(), // defaults to cluster default
      })
      .optional(),

    // Git workspace caching and persistence options.
    gitCache: z
      .object({
        // When true (default), runs reuse an existing worktree from a previous
        // run for the same task rather than creating a fresh one.  The init
        // container runs `git fetch` to update the mirror and then resumes the
        // worktree as-is.  Set to false to always start with a clean checkout.
        worktreeReuse: z.boolean().default(true),
      })
      .optional(),

    // System packages inherited from project or overridden per-run.
    runner: RunnerPackagesSchema,
  })
  .refine((s) => s.interactive || !!s.task, {
    message: "spec.task is required unless spec.interactive is true",
    path: ["task"],
  });

export type RunSpec = z.infer<typeof RunSpecSchema>;

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

export const RunStatusSchema = z
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

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
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
  spec: RunSpecSchema,
  status: RunStatusSchema.optional(),
});

export type Run = z.infer<typeof RunSchema>;

// ---------------------------------------------------------------------------
// Project — project config and settings.
//
// Tasks are no longer embedded in the project spec. They live as separate
// Task CRs that reference the project via spec.projectRef.

// Task type enum
export const TaskType = {
  Plan: "PLAN",
  Build: "BUILD",
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

// New task phase enum — authoritative internal state
export const TaskPhase = z.enum([
  // Pre-work
  "idea",              // Parking lot, not actionable
  "pending",           // Well-defined, waiting for scheduling
  // Active work
  "scheduled",         // Scheduler picked it, run being created
  "initializing",      // Pod starting, git checkout in progress
  "running",           // Agent actively working
  "waiting-for-input", // PLAN-only: agent asked a question
  // Post-work
  "succeeded",         // Run completed successfully
  "reviewing",         // AI reviewer evaluating (optional)
  "awaiting-human",    // Needs human decision (approve/reject/answer question)
  "awaiting-merge",    // Merge run in progress
  "rework-requested",  // Human gave feedback, waiting for scheduling slot
  "generating-builds", // PLAN-only: buildgen facilitator splitting into tasks
  "awaiting-children",     // Waiting for all child tasks to complete
  "awaiting-feature-merge", // Feature branch merge run in progress
  // Terminal
  "done",              // Complete
  // Failure
  "failed",            // Run failed, needs human decision
]);
export type TaskPhase = z.infer<typeof TaskPhase>;

// Board column enum — computed client-side from phase, never stored
export const BoardColumn = z.enum(["ideas", "backlog", "in-progress", "review", "done", "blocked"]);
export type BoardColumn = z.infer<typeof BoardColumn>;

// Compute board column from task phase
export function computeBoardColumn(phase: TaskPhase): BoardColumn {
  if (phase === "idea") return "ideas";
  if (phase === "pending") return "backlog";
  if (phase === "done") return "done";
  if (phase === "awaiting-children") return "blocked";
  if (["waiting-for-input", "succeeded", "reviewing", "awaiting-human", "failed"].includes(phase))
    return "review";
  return "in-progress";
}

// Legacy task column enum — kept for backwards compatibility during migration
export const TaskColumn = {
  Backlog: "backlog",
  Ready: "ready",
  InProgress: "in-progress",
  Review: "review",
  Rework: "rework",
  Done: "done",
  Blocked: "blocked",
} as const;
export type TaskColumn = (typeof TaskColumn)[keyof typeof TaskColumn];

// Per-worker execution tracking — now lives in Task.status.worker.
export const WorkerStatusSchema = z.object({
  runName: z.string().optional(),
  status: z.enum(["Running", "Succeeded", "Failed", "Escalated"]),
  branch: z.string().optional(),
  // Feature branching metadata (when featureBranchingEnabled: true).
  gitBranch: z.string().optional(),
  parentBranch: z.string().optional(),
  mergeIntoBranch: z.string().optional(),
  prNumber: z.number().int().min(1).optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  retryCount: z.number().int().min(0).default(0),
  // AI reviewer rework count — incremented on AI request_changes, reset on human action.
  aiReworkCount: z.number().int().min(0).default(0),
  // Name of the success-review facilitator run (set after worker Succeeded).
  reviewRunName: z.string().optional(),
  // BUILD task generation tracking (for PLAN tasks).
  buildTasksFacilitatorRun: z.string().optional(),
  buildTasksCreated: z.boolean().optional(),
  // CR names (metadata.name) of BUILD tasks created from this PLAN task.
  createdBuildTaskRefs: z.array(z.string()).optional(),
  reviewApproved: z.boolean().optional(),
  reviewFeedback: z.string().max(4096).optional(),
  mergeRunName: z.string().optional(),
  mergedAt: z.string().optional(),
  mergeError: z.string().max(4096).optional(),
});

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const PendingQuestionSchema = z.object({
  workerId: z.string(),
  sessionID: z.string(),
  messageText: z.string().max(16384),
});

export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

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

// Project-level board status summary — only lightweight metrics remain here.
// Full task state lives in Task CRs.
export const SuggestionSchema = z.object({
  type: z.enum(["missing_tool", "performance", "reliability"]),
  severity: z.enum(["info", "suggestion", "warning"]),
  source: z.string(),
  message: z.string(),
  recommendation: z.string(),
  taskName: z.string().optional(),
  createdAt: z.string(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const BoardStatusSchema = z.object({
  activeWorkers: z.number().int().min(0).default(0),
  escalations: z.string().array().optional(),
  pendingQuestions: PendingQuestionSchema.array().optional(),
  facilitations: FacilitationResultSchema.array().optional(),
  lastEventAt: z.string().optional(),
  /** Manager reconciliation metrics — written by manager-controller. */
  managerMetrics: ManagerMetricsSchema.optional(),
  /** Tool gap analysis suggestions. */
  suggestions: SuggestionSchema.array().optional(),
});

export type BoardStatus = z.infer<typeof BoardStatusSchema>;

// Project spec — project config and settings.
export const ProjectSpecSchema = z.object({
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

  // Shell script to run after git clone completes, before opencode starts.
  // Runs as part of the workspace-init init container. Failure (non-zero exit)
  // will cause the pod to fail and not start.
  initScript: z.string().optional(),

  // WIP limit: max concurrent worker runs. Default 2.
  maxParallel: z.number().int().min(1).max(20).default(2),

  // Team roster: which ClusterAgents are available to this project's tasks.
  // Task.agent must reference a name from this list.
  agents: AgentRefSchema.array().optional(),

  // Board lifecycle phase.
  phase: z.enum(["Active", "Complete", "Archived"]).default("Active"),

  // Data PVC configuration — shared cache, git mirrors and worktrees.
  data: z
    .object({
      pvcName: z.string().optional(),    // defaults to `{project}-data`
      mountPath: z.string().default("/data"),
      storageClass: z.string().optional(),
    })
    .optional(),

  // Git workspace caching and persistence options.
  gitCache: z
    .object({
      worktreeReuse: z.boolean().default(true),
    })
    .optional(),

  // Feature branch workflow — when true, tasks work on isolated feature branches.
  // PLAN tasks use feature/{plan-id}, BUILD tasks use feature/{plan-id}/{build-id}.
  // Default: false (all tasks work on main branch).
  featureBranchingEnabled: z.boolean().default(false),
  
  // Retry policy — auto-retry behavior on task failure.
  retryPolicy: z.object({
    enabled: z.boolean().default(false),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    backoffSeconds: z.number().int().min(5).max(600).default(30),
    backoffMultiplier: z.number().min(1).max(5).default(2),
    maxBackoffSeconds: z.number().int().min(5).max(3600).default(300),
    poisonPillThresholdSeconds: z.number().int().min(0).max(300).default(30),
  }).optional(),
  
  // Review policy — AI reviewer opt-in and rework ceiling.
  reviewPolicy: z.object({
    aiReviewerEnabled: z.boolean().default(false),
    aiReviewerAgent: z.string().max(63).default("reviewer"),
    maxAutoReworks: z.number().int().min(1).max(10).default(2),
  }).optional(),

  // Flow configuration — user-configurable task lifecycle.
  // Presets provide sensible defaults; individual fields override preset behavior.
  flow: z.object({
    preset: z.enum([
      "simple",
      "review",
      "plan-build",
      "plan-build-review-merge",
    ]).default("plan-build-review-merge"),
    humanApproval: z.object({
      plan: z.enum(["required", "disabled"]).default("required").optional(),
      build: z.enum(["required", "disabled"]).default("required").optional(),
    }).optional(),
    plan: z.object({
      onApprove: z.enum(["generate-builds", "done"]).default("generate-builds").optional(),
      buildGeneration: z.enum(["ai", "manual", "disabled"]).default("ai").optional(),
      buildGenerationAgent: z.string().max(63).default("buildgen").optional(),
      defaultAgent: z.string().max(63).default("planner").optional(),
    }).optional(),
    build: z.object({
      onSuccess: z.enum(["human-review", "ai-review", "done"]).default("human-review").optional(),
      onApprove: z.enum(["merge", "done"]).default("merge").optional(),
      defaultAgent: z.string().max(63).default("builder").optional(),
    }).optional(),
    merge: z.object({
      mode: z.enum(["auto", "manual", "disabled"]).default("auto").optional(),
      agent: z.string().max(63).default("integrator").optional(),
    }).optional(),
    integration: z.object({
      mode: z.enum(["auto-merge", "manual", "disabled"]).default("auto-merge").optional(),
      agent: z.string().max(63).default("integrator").optional(),
    }).optional(),
    review: z.object({
      aiReviewerEnabled: z.boolean().default(false).optional(),
      agent: z.string().max(63).default("reviewer").optional(),
      maxAutoReworks: z.number().int().min(1).max(10).default(2).optional(),
    }).optional(),
    retry: z.object({
      enabled: z.boolean().default(false).optional(),
      maxAttempts: z.number().int().min(1).max(10).default(3).optional(),
      backoffSeconds: z.number().int().min(5).max(600).default(30).optional(),
      backoffMultiplier: z.number().min(1).max(5).default(2).optional(),
      maxBackoffSeconds: z.number().int().min(5).max(3600).default(300).optional(),
      poisonPillThresholdSeconds: z.number().int().min(0).max(300).default(30).optional(),
    }).optional(),
    timeouts: z.object({
      runningStaleSeconds: z.number().int().min(30).max(86400).default(1800).optional(),
      reviewStaleSeconds: z.number().int().min(30).max(86400).default(600).optional(),
      mergeStaleSeconds: z.number().int().min(30).max(86400).default(600).optional(),
      buildgenStaleSeconds: z.number().int().min(30).max(86400).default(600).optional(),
    }).optional(),
  }).optional(),

  // Per-project code-server for interactive workspace access.
  // Requires source.git or source.local (needs a data PVC to mount).
  // Access via kubectl port-forward, or configure ingress in infrastructure.
  codeServer: CodeServerSpecSchema.optional(),

  // Per-project memory service with vector embeddings for agent context/memory.
  // Requires source.git or source.local (needs a data PVC to mount).
  // When enabled, the operator deploys a memory-{project} Deployment + Service
  // that stores and searches semantic vectors via bun:sqlite + sqlite-vec.
  embedding: EmbeddingSpecSchema.optional(),

  // System packages (apk) installed into every run pod for this project.
  // Declared once on the project, inherited by all runs and board workers.
  runner: RunnerPackagesSchema,
});

export type ProjectSpec = z.infer<typeof ProjectSpecSchema>;

// Project status — summary only; full task state lives in Task CRs.
export const ProjectStatusSchema = z.object({
  board: BoardStatusSchema.optional(),
});

export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
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
  spec: ProjectSpecSchema,
  status: ProjectStatusSchema.optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------------------
// Task — a PLAN or BUILD task belonging to a project.
//
// Tasks are namespaced CRs that reference their parent Project via
// spec.projectRef. They carry an ownerReference to the project so they are
// automatically garbage-collected when the project is deleted.
//
// CR naming convention: {project}-plan-{random6} / {project}-build-{random6}
// The CR metadata.name is the canonical task identifier everywhere.

export const TaskSpecSchema = z.object({
  // Name of the parent Project in the same namespace.
  projectRef: z.string().min(1),

  // Task type.
  type: z.enum(["PLAN", "BUILD"]),

  // Short human-readable title shown on the task card.
  title: z.string().min(1).max(256),

  // Detailed context + acceptance criteria sent to the worker agent.
  description: z.string().max(8192).optional(),

  // Priority for ordering within a column.
  priority: z.enum(["high", "medium", "low"]).default("medium"),

  // Which ClusterAgent from the project's agents list handles this task.
  agent: z.string().min(1),

  // BUILD only: CR name of the PLAN task that generated this BUILD task.
  parentTaskRef: z.string().optional(),

  // BUILD only: CR name of the preceding BUILD task in the serial chain.
  // This BUILD task will remain blocked until its predecessor reaches "done".
  predecessorRef: z.string().optional(),

  // BUILD only: CR name of the following BUILD task in the serial chain.
  successorRef: z.string().optional(),
  
  // Task-level retry policy override (merges with project-level policy).
  retryPolicy: z.object({
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    backoffSeconds: z.number().int().min(5).max(600).optional(),
  }).optional(),
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const TaskStatusSchema = z.object({
  // Internal phase — authoritative state for reconciler logic.
  phase: TaskPhase.default("pending"),
  
  // Blocked flag — when true, task is excluded from scheduling regardless of phase.
  blocked: z.boolean().default(false),
  blockedReason: z.string().max(1024).optional(),
  
  // Retry backoff — when set, scheduler skips this task until retryAfter time passes.
  retryAfter: z.string().optional(),
  lastFailureReason: z.string().max(4096).optional(),
  lastFailureDuration: z.number().optional(),
  
  // Legacy column field — kept for backwards compatibility, never written by new code.
  column: z
    .enum(["backlog", "ready", "in-progress", "review", "rework", "done", "blocked"])
    .optional(),

  // Worker execution state — set when phase is scheduled or beyond.
  worker: WorkerStatusSchema.optional(),
}).partial();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  apiVersion: z.literal(API_GROUP_VERSION),
  kind: z.literal(KIND_TASK),
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
  spec: TaskSpecSchema,
  status: TaskStatusSchema.optional(),
});

export type Task = z.infer<typeof TaskSchema>;

// ---------------------------------------------------------------------------
// Well-known label/annotation keys and container naming.

export const LABELS = {
  managedBy: "app.kubernetes.io/managed-by",
  component: "percussionist.dev/component",
  runName: "percussionist.dev/run",
  projectName: "percussionist.dev/project",
  taskId: "percussionist.dev/task-id",
} as const;

/** Annotation key prefixes used for board actions. */
export const ANNOTATION_PREFIXES = [
  "approved",
  "request-changes",
  "rework",
  "abandon",
  "answer",
] as const;

/**
 * Build a K8s-safe annotation name part (after the `/`) that is ≤63 bytes.
 * Uses a short hash suffix to guarantee uniqueness when the prefix+taskName
 * exceeds the 63-byte limit.
 */
export function annotationKey(prefix: string, taskName: string): string {
  const key = `${prefix}-${taskName}`;
  if (key.length <= 63) return key;
  let hash = 0;
  for (let i = 0; i < taskName.length; i++) {
    hash = ((hash << 5) - hash) + taskName.charCodeAt(i);
    hash |= 0;
  }
  const hashStr = Math.abs(hash).toString(36).slice(0, 6);
  const maxPrefix = 63 - hashStr.length - 1;
  return `${key.slice(0, maxPrefix).replace(/-+$/, "")}-${hashStr}`;
}

export const MANAGED_BY = "percussionist";

export const CONTAINER_PORT = 4096;
// MCP server port served by the dispatcher sidecar. Chosen to be adjacent to
// CONTAINER_PORT and unlikely to clash with common development tooling.
export const DISPATCHER_MCP_PORT = 4097;
export const RUNNER_CONTAINER = "opencode";
export const DISPATCHER_CONTAINER = "dispatcher";
export const GIT_CLONE_CONTAINER = "workspace-init";
export const CODE_SERVER_CONTAINER = "code-server";
export const CODE_SERVER_PORT = 8080;
export const CODE_SERVER_DEFAULT_IMAGE = "codercom/code-server:4.96.4";

// ---------------------------------------------------------------------------
// Config resolution helpers.
//
// Resolves the effective run config by merging project defaults and
// explicit run-level values.
// Called at creation time in CLI and manager-controller.

export interface ResolvedRunConfig {
  model?: string;
  image: string;
  timeoutSeconds: number;
  resources?: ResourceRequirements;
  secrets?: SecretsRef;
  source?: { git?: GitSource; local?: boolean };
  sidecars?: SidecarSpec[];
  injectFiles?: InjectFileRef[];
  initScript?: string;
  data?: { pvcName?: string; mountPath?: string; storageClass?: string };
  gitCache?: { worktreeReuse?: boolean };
  packages?: string[];
}

// clusterBase — optional cluster-level defaults from ClusterSettings.spec.
// When provided, its runner defaults and secrets fill gaps in the hierarchy:
//   runOverrides  >  project  >  clusterBase
export function resolveRunConfig(
  project: ProjectSpec,
  boardOverrides?: { model?: string; image?: string; timeoutSeconds?: number; resources?: ResourceRequirements },
  runOverrides?: Partial<ResolvedRunConfig>,
  clusterBase?: {
    runner?: { image?: string; timeoutSeconds?: number; resources?: ResourceRequirements };
    secrets?: SecretsRef;
  },
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
      clusterBase?.runner?.image ??
      "ghcr.io/erkkaha/percussionist/runner:latest",
    timeoutSeconds:
      runOverrides?.timeoutSeconds ??
      boardOverrides?.timeoutSeconds ??
      project.timeoutSeconds ??
      clusterBase?.runner?.timeoutSeconds ??
      3600,
    resources:
      runOverrides?.resources ??
      boardOverrides?.resources ??
      project.resources ??
      clusterBase?.runner?.resources,
    secrets: runOverrides?.secrets ?? project.secrets ?? clusterBase?.secrets,
    source: structuredClone(project.source),
    sidecars: project.sidecars,
    injectFiles: project.injectFiles,
    initScript: project.initScript,
    data: runOverrides?.data ?? project.data,
    gitCache: runOverrides?.gitCache ?? project.gitCache,
    packages: runOverrides?.packages ?? project.runner?.packages,
  };
}


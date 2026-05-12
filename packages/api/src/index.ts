// OpenCodeRun — the core CRD that the operator reconciles.
//
// Zod schemas are the single source of truth. The CRD YAML in crds/ is
// generated from (and must stay in sync with) these schemas; when they
// disagree the Zod definition wins at admission time inside the operator.

import { z } from "zod";

export const API_GROUP = "percussionist.dev";
export const API_VERSION = "v1alpha1";
export const API_GROUP_VERSION = `${API_GROUP}/${API_VERSION}`;
export const KIND_RUN = "OpenCodeRun";
export const PLURAL_RUN = "opencoderuns";
export const KIND_PROJECT = "OpenCodeProject";
export const PLURAL_PROJECT = "opencodeprojects";
export const KIND_CLUSTER_AGENT = "ClusterAgent";
export const PLURAL_CLUSTER_AGENT = "clusteragents";
export const KIND_KANBAN = "OpenCodeKanban";
export const PLURAL_KANBAN = "opencodekanbans";

// ---------------------------------------------------------------------------
// Spec

export const ResourceRequirementsSchema = z
  .object({
    requests: z.record(z.string()).optional(),
    limits: z.record(z.string()).optional(),
  })
  .partial();

export const SecretsRefSchema = z
  .object({
    // Env-projected: provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
    // All keys in the secret are exposed as environment variables verbatim.
    llmKeysSecret: z.string().optional(),
    // Deprecated: use spec.source.git.sshSecret instead. Retained so
    // existing CRs don't blow up on admission.
    gitSSHSecret: z.string().optional(),
    // Reference to a Secret whose `key` (default: "auth.json") holds the
    // full contents of opencode's auth.json. Projected into the runner
    // as the env var OPENCODE_AUTH_CONTENT, which opencode consults
    // before reading ~/.local/share/opencode/auth.json on disk.
    //
    // Use this for providers that require OAuth / device-code login —
    // GitHub Copilot, ChatGPT Plus, Claude Pro — where a static API key
    // isn't available. Obtain once on a workstation via
    // `opencode auth login <provider>`, then ship the resulting auth.json
    // slice into a cluster Secret with `beatctl auth import`.
    //
    // Orthogonal to llmKeysSecret: both may be set. If both configure
    // the same provider, opencode's auth.json entry wins.
    opencodeAuthSecret: z
      .object({
        name: z.string().min(1),
        key: z.string().default("auth.json"),
      })
      .optional(),
  })
  .partial();

// Source of truth for /workspace. M4 ships only `git` (clone before the
// runner starts). Later we may add `pvc`, `configMap`, `inline`, etc.
//
// Absent → runner starts with an empty /workspace (pre-M4 behaviour).
export const GitSourceSchema = z.object({
  // Any git URL git(1) understands: https, ssh, git://, file://. For
  // private repos prefer ssh + sshSecret; https+token is not yet wired.
  url: z.string().min(1),

  // Branch, tag, or commit SHA. Omitted → remote HEAD (whatever the
  // server reports as the default branch). We clone with --depth=1 when
  // ref is a branch/tag; full clone for raw SHAs (shallow fetch by SHA
  // isn't supported on all servers).
  ref: z.string().optional(),

  // Reference to a Secret containing an SSH private key. Must live in the
  // same namespace as the CR. Typical source: `kubectl create secret
  // generic agent-key --from-file=ssh-privatekey=~/.ssh/id_ed25519
  // --type=kubernetes.io/ssh-auth`. The key is mounted read-only into the
  // init container at /etc/git-ssh/id and GIT_SSH_COMMAND is set to
  // point at it with StrictHostKeyChecking=no (lab-friendly; swap for a
  // known_hosts mount once we're past the homelab).
  sshSecret: z
    .object({
      name: z.string().min(1),
      // Key inside the Secret that holds the private key. Defaults to
      // `ssh-privatekey`, which is what `--type=kubernetes.io/ssh-auth`
      // enforces.
      key: z.string().default("ssh-privatekey"),
    })
    .optional(),

  // Optional git commit author identity injected into the runner
  // environment as GIT_AUTHOR_* and GIT_COMMITTER_*.
  author: z
    .object({
      name: z.string().min(1),
      email: z.string().min(1),
    })
    .optional(),
});

export const SourceSchema = z.object({
  git: GitSourceSchema.optional(),
});

export const ExposeSchema = z
  .object({
    // When true (and the operator has PERCUSSIONIST_INGRESS_BASE_DOMAIN set)
    // the operator creates a per-run Ingress so the opencode web UI is
    // reachable at http://<run>.<baseDomain>/ without a password.
    // Defaults to true when the operator has a base domain configured.
    web: z.boolean().default(true),
  })
  .partial();

export const AgentDefSchema = z.object({
  // Unique name for this agent (used as filename and selection key).
  // Must be k8s-compatible: lowercase alphanumeric + hyphens, max 63 chars.
  name: z.string().min(1).max(63),

  // Full .md file contents (YAML front-matter + system prompt).
  // Max 100KB to keep ConfigMaps manageable.
  content: z.string().max(102400),
});

export const OpenCodeRunSpecSchema = z
  .object({
    // What the agent should do. Sent as the first user prompt via
    // prompt_async. Required unless `interactive: true`, in which case the
    // dispatcher skips prompt submission entirely and the user drives the
    // session via `beatctl attach`.
    task: z.string().min(1).optional(),

    // Interactive mode: the dispatcher only waits for the runner to be
    // healthy, patches status to Running("waiting for attach"), and sleeps
    // until the CR is deleted or the hard timeout fires. No automated
    // prompt is submitted — the user is expected to attach with
    // `beatctl attach` and drive the session by hand. Terminal phase is
    // reached via delete (Cancelled) or timeout (Failed).
    //
    // `timeoutSeconds` still applies: interactive pods are hard-killed by
    // kubelet when the Pod's activeDeadlineSeconds (= timeoutSeconds)
    // fires. Bump it in the spec if you want a longer-lived REPL (at the
    // cost of losing the safety valve against forgotten sessions).
    interactive: z.boolean().default(false),

    // Optional. Defaults applied by the operator.
    agent: z.string().optional(),

    // Inline agent definitions injected into the run pod at
    // /workspace/.opencode/agents/<name>.md before opencode starts.
    // Max 5 agents, each content capped at 100KB. The operator creates a
    // ConfigMap from these and mounts it as a volume so opencode discovers
    // them via its standard .opencode/ walk-up mechanism.
    agents: AgentDefSchema.array().max(5).optional(),

    model: z.string().optional(),
    image: z.string().default("percussionist/runner:dev"),

    resources: ResourceRequirementsSchema.optional(),
    secrets: SecretsRefSchema.optional(),

    // Optional workspace source. When `source.git` is set the operator
    // inserts an init container that clones the repo into /workspace
    // before the runner starts; opencode then starts with working
    // directory /workspace. Absent → /workspace is an empty emptyDir.
    source: SourceSchema.optional(),

    // Hard upper bound on total run time. Operator deletes the Job when
    // elapsed > timeoutSeconds. 0 = no limit (discouraged).
    timeoutSeconds: z.number().int().positive().default(3600),

    // Garbage collection: how long to keep the CR after terminal phase.
    ttlSecondsAfterFinished: z.number().int().nonnegative().default(3600),

    // Controls per-run Ingress creation when the operator has
    // PERCUSSIONIST_INGRESS_BASE_DOMAIN configured.
    expose: ExposeSchema.optional(),
  })
  // Either a task or interactive=true must be supplied. Enforced here so the
  // operator doesn't have to double-check at reconcile time.
  .refine((s) => s.interactive || !!s.task, {
    message: "spec.task is required unless spec.interactive is true",
    path: ["task"],
  });

export type OpenCodeRunSpec = z.infer<typeof OpenCodeRunSpecSchema>;

// ---------------------------------------------------------------------------
// Status

export const RunPhase = {
  Pending: "Pending",
  Initializing: "Initializing",
  Running: "Running",
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
      RunPhase.Succeeded,
      RunPhase.Failed,
      RunPhase.Cancelled,
    ]),
    message: z.string().optional(),
    podName: z.string().optional(),
    serviceName: z.string().optional(),
    sessionID: z.string().optional(),
    // Wall-clock timestamps, RFC3339.
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    lastEventAt: z.string().optional(),
    // Rough running token totals streamed from /event.
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    // Opencode web UI URL — set when the operator has created a per-run
    // Ingress (requires PERCUSSIONIST_INGRESS_BASE_DOMAIN on the operator).
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

// ---------------------------------------------------------------------------
// Full object

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
    })
    .passthrough(),
  spec: OpenCodeRunSpecSchema,
  status: OpenCodeRunStatusSchema.optional(),
});

export type OpenCodeRun = z.infer<typeof OpenCodeRunSchema>;

// ---------------------------------------------------------------------------
// ClusterAgent — cluster-scoped catalog of reusable agent definitions.
//
// Admins create ClusterAgents to make agents available across all projects
// and runs without duplicating content. The operator watches them read-only;
// they are not reconciled into pods themselves — instead, a run references
// one by name (spec.agent) or includes inline copies in spec.agents[].

export const ClusterAgentSpecSchema = z.object({
  // Full .md file contents (YAML front-matter + system prompt).
  content: z.string().max(102400),
});

export type ClusterAgentSpec = z.infer<typeof ClusterAgentSpecSchema>;

export const ClusterAgentSchema = z.object({
  apiVersion: z.literal(API_GROUP_VERSION),
  kind: z.literal("ClusterAgent"),
  metadata: z
    .object({
      name: z.string(),
      namespace: z.string().optional(),
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
// Well-known label/annotation keys and container naming.

export const LABELS = {
  managedBy: "app.kubernetes.io/managed-by",
  component: "percussionist.dev/component",
  runName: "percussionist.dev/run",
} as const;

export const MANAGED_BY = "percussionist";

export const CONTAINER_PORT = 4096;
export const RUNNER_CONTAINER = "opencode";
export const DISPATCHER_CONTAINER = "dispatcher";
export const GIT_CLONE_CONTAINER = "git-clone";

// ---------------------------------------------------------------------------
// OpenCodeProject — reusable template for creating runs.
//
// Projects collect the "boring" parts of a run spec (git URL, ref, SSH/LLM/
// auth secrets, default model/agent) under a short name so users don't have
// to re-enter them on every submit. A project has no lifecycle of its own —
// it is a passive config object, not reconciled by the operator. Runs built
// from a project copy the project's values into their own spec at creation
// time; later edits to the project do not rewrite existing runs.

export const OpenCodeProjectSpecSchema = z.object({
  // Human-readable label for the UI. Falls back to metadata.name.
  displayName: z.string().optional(),

  // Same shape as OpenCodeRunSpec.source / .secrets / .model / .agent so
  // we can shallow-merge them into a run spec with no field remapping.
  source: SourceSchema.optional(),
  secrets: SecretsRefSchema.optional(),
  model: z.string().optional(),
  agent: z.string().optional(),
});

export type OpenCodeProjectSpec = z.infer<typeof OpenCodeProjectSpecSchema>;

export const OpenCodeProjectSchema = z.object({
  apiVersion: z.literal(API_GROUP_VERSION),
  kind: z.literal(KIND_PROJECT),
  metadata: z
    .object({
      name: z.string(),
      namespace: z.string().optional(),
      uid: z.string().optional(),
      resourceVersion: z.string().optional(),
      labels: z.record(z.string()).optional(),
      annotations: z.record(z.string()).optional(),
      creationTimestamp: z.string().optional(),
    })
    .passthrough(),
  spec: OpenCodeProjectSpecSchema,
});

export type OpenCodeProject = z.infer<typeof OpenCodeProjectSchema>;

// ---------------------------------------------------------------------------
// OpenCodeKanban — kanban board for agentic development.
//
// Tracks feature-sized tasks flowing through columns (ready → in-progress →
// review → done). A persistent manager controller watches this CR and dispatches
// worker runs, respecting a WIP limit derived from cluster capacity.

export const KanbanTaskSchema = z.object({
  // Unique task identifier (e.g. "F-104", "BUG-42").
  id: z.string().min(1).max(32),

  // Short human-readable title.
  title: z.string().min(1).max(256),

  // Detailed acceptance criteria and context sent to the worker agent.
  description: z.string().max(8192).optional(),

  // Task priority for ordering within a column.
  priority: z.enum(["high", "medium", "low"]).default("medium"),
});

export type KanbanTask = z.infer<typeof KanbanTaskSchema>;

// Per-worker tracking in Kanban status.
export const WorkerStatusSchema = z.object({
  // Task ID this worker is handling.
  taskId: z.string().min(1),

  // OpenCodeRun name created for this worker (set by manager controller).
  runName: z.string().optional(),

  // Current worker state.
  status: z.enum(["Running", "Succeeded", "Failed", "Escalated"]),

  // Git branch created by the worker (e.g. "feat/F-104").
  branch: z.string().optional(),

  // GitHub PR number if opened (set by manager after detecting PR).
  prNumber: z.number().int().min(1).optional(),

  // ISO timestamp when worker started.
  startedAt: z.string().optional(),

  // ISO timestamp when worker finished.
  completedAt: z.string().optional(),

  // Escalation text written by the manager when a worker is stuck.
  escalation: z.string().max(4096).optional(),

  // Number of retry attempts for this task (set by manager on re-dispatch).
  retryCount: z.number().int().min(0).default(0),
});

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

// Default run config inherited by all worker runs.
export const KanbanDefaultsSchema = z.object({
  model: z.string().optional(),
  timeoutSeconds: z.number().int().min(60).default(14400),
  resources: ResourceRequirementsSchema.optional(),
}).partial();

export type KanbanDefaults = z.infer<typeof KanbanDefaultsSchema>;

// OpenCodeKanban spec — board configuration.
export const OpenCodeKanbanSpecSchema = z.object({
  // Human-readable label; falls back to metadata.name.
  displayName: z.string().optional(),

  // Git workspace all workers clone from (same shape as OpenCodeRun's source.git).
  source: SourceSchema.optional(),

  // Default run config inherited by all worker runs.
  defaults: KanbanDefaultsSchema.optional(),

  // WIP limit — how many concurrent worker runs the manager dispatches.
  maxParallel: z.number().int().min(1).max(20).default(2),

  // Inline agent definitions injected into worker pods (same shape as OpenCodeRun's agents[]).
  agents: AgentDefSchema.array().max(5).optional(),

  // Human-defined backlog items added to the board.
  tasks: KanbanTaskSchema.array().max(100).optional(),

  // Board lifecycle state.
  phase: z.enum(["Active", "Complete", "Archived"]).default("Active"),
});

export type OpenCodeKanbanSpec = z.infer<typeof OpenCodeKanbanSpecSchema>;

// OpenCodeKanban status — operational state tracked by the manager controller.
export const OpenCodeKanbanStatusSchema = z.object({
  // Mirrors spec.phase with operational state.
  phase: z.enum(["Active", "Complete", "Archived"]).optional(),

  // Ordered list of column names on the kanban board.
  columns: z.string().array().default(["ready", "in-progress", "review", "rework", "done"]),

  // Map of column name → task ID array. Manager moves IDs between these arrays.
  backlog: z.record(z.string().array()).default({ ready: [] }),

  // Active worker run tracking.
  workers: WorkerStatusSchema.array().default([]),

  // Count of workers with Running status (for printer column).
  activeWorkers: z.number().int().min(0).default(0),

  // JSON-serialized escalation messages for quick CLI/UI access.
  escalations: z.string().array().optional(),

  // ISO timestamp of the most recent state change.
  lastEventAt: z.string().optional(),
});

export type OpenCodeKanbanStatus = z.infer<typeof OpenCodeKanbanStatusSchema>;

// Full OpenCodeKanban CR shape.
export const OpenCodeKanbanSchema = z.object({
  apiVersion: z.literal(API_GROUP_VERSION),
  kind: z.literal(KIND_KANBAN),
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
  spec: OpenCodeKanbanSpecSchema,
  status: OpenCodeKanbanStatusSchema.optional(),
});

export type OpenCodeKanban = z.infer<typeof OpenCodeKanbanSchema>;

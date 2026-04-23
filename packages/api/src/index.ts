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

import type { Task, Project, TaskPhase, Run } from "@percussionist/api";

export function makeTask(
  name: string,
  projectRef: string,
  overrides?: {
    type?: "PLAN" | "BUILD";
    phase?: TaskPhase;
    priority?: "high" | "medium" | "low";
    predecessorRef?: string;
    parentTaskRef?: string;
    blocked?: boolean;
    retryAfter?: string;
    retryCount?: number;
    aiReworkCount?: number;
    runName?: string;
    status?: string;
    mergedAt?: string;
    gitBranch?: string;
    /** When true, omit the entire `status` field (simulates a task created without phase). */
    noStatus?: boolean;
  },
): Task {
  const now = "2026-05-29T00:00:00.000Z";

  if (overrides?.noStatus) {
    return {
      apiVersion: "percussionist.dev/v1alpha1",
      kind: "Task",
      metadata: { name, namespace: "percussionist", uid: `uid-${name}` },
      spec: {
        projectRef,
        type: overrides?.type ?? "BUILD",
        title: name,
        description: "",
        agent: "builder",
        priority: overrides?.priority ?? "medium",
        ...(overrides?.predecessorRef ? { predecessorRef: overrides.predecessorRef } : {}),
        ...(overrides?.parentTaskRef ? { parentTaskRef: overrides.parentTaskRef } : {}),
      },
    } as Task;
  }

  return {
    apiVersion: "percussionist.dev/v1alpha1",
    kind: "Task",
    metadata: { name, namespace: "percussionist", uid: `uid-${name}` },
    spec: {
      projectRef,
      type: overrides?.type ?? "BUILD",
      title: name,
      description: "",
      agent: "builder",
      priority: overrides?.priority ?? "medium",
      ...(overrides?.predecessorRef ? { predecessorRef: overrides.predecessorRef } : {}),
      ...(overrides?.parentTaskRef ? { parentTaskRef: overrides.parentTaskRef } : {}),
    },
    status: {
      phase: overrides?.phase ?? "pending",
      blocked: overrides?.blocked ?? false,
      ...(overrides?.retryAfter ? { retryAfter: overrides.retryAfter } : {}),
      ...(overrides?.retryCount !== undefined ? { worker: { retryCount: overrides.retryCount } } : {}),
      ...(overrides?.aiReworkCount !== undefined ? { worker: { aiReworkCount: overrides.aiReworkCount } } : {}),
      worker: {
        ...(overrides?.retryCount !== undefined ? { retryCount: overrides.retryCount } : {}),
        ...(overrides?.aiReworkCount !== undefined ? { aiReworkCount: overrides.aiReworkCount } : {}),
        ...(overrides?.runName ? { runName: overrides.runName } : {}),
        ...(overrides?.status ? { status: overrides.status as "Running" | "Succeeded" | "Failed" } : {}),
        ...(overrides?.mergedAt ? { mergedAt: overrides.mergedAt } : {}),
        ...(overrides?.gitBranch ? { gitBranch: overrides.gitBranch } : {}),
      },
    },
  } as Task;
}

export function makeProject(
  name: string,
  overrides?: {
    maxParallel?: number;
    featureBranchingEnabled?: boolean;
    source?: { git?: { url: string; ref?: string } };
    agents?: Array<{ name: string }>;
    retryPolicy?: {
      enabled?: boolean;
      maxAttempts?: number;
      backoffSeconds?: number;
      backoffMultiplier?: number;
      maxBackoffSeconds?: number;
      poisonPillThresholdSeconds?: number;
    };
    reviewPolicy?: {
      aiReviewerEnabled?: boolean;
      aiReviewerAgent?: string;
      maxAutoReworks?: number;
    };
  },
): Project {
  return {
    apiVersion: "percussionist.dev/v1alpha1",
    kind: "Project",
    metadata: { name, namespace: "percussionist", uid: `uid-${name}` },
    spec: {
      maxParallel: overrides?.maxParallel ?? 2,
      agents: overrides?.agents,
      ...(overrides?.source ? { source: overrides.source } : {}),
      ...(overrides?.featureBranchingEnabled !== undefined ? { featureBranchingEnabled: overrides.featureBranchingEnabled } : {}),
      ...(overrides?.retryPolicy ? { retryPolicy: overrides.retryPolicy } : {}),
      ...(overrides?.reviewPolicy ? { reviewPolicy: overrides.reviewPolicy } : {}),
    },
  } as Project;
}

export function makeRun(
  name: string,
  overrides?: {
    phase?: "Pending" | "Initializing" | "Running" | "WaitingForInput" | "Succeeded" | "Failed" | "Cancelled";
    lastEventAt?: string;
    startedAt?: string;
    completedAt?: string;
    message?: string;
  },
): Run {
  return {
    apiVersion: "percussionist.dev/v1alpha1",
    kind: "Run",
    metadata: { name, namespace: "percussionist" },
    spec: {
      project: "test-project",
      task: "test task",
      interactive: false,
      agent: "builder",
    },
    status: {
      phase: overrides?.phase,
      ...(overrides?.lastEventAt ? { lastEventAt: overrides.lastEventAt } : {}),
      ...(overrides?.startedAt ? { startedAt: overrides.startedAt } : {}),
      ...(overrides?.completedAt ? { completedAt: overrides.completedAt } : {}),
      ...(overrides?.message ? { message: overrides.message } : {}),
    },
  } as Run;
}

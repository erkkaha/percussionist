// Flow resolver — merges project flow config, presets, and legacy policies.

import type { Project } from "@percussionist/api";

export interface ResolvedFlow {
  preset: string;
  humanApproval: {
    plan: "required" | "disabled";
    build: "required" | "disabled";
  };
  plan: {
    onApprove: "generate-builds" | "done";
    buildGeneration: "ai" | "manual" | "disabled";
    buildGenerationAgent: string;
    defaultAgent: string;
  };
  build: {
    onSuccess: "human-review" | "ai-review" | "done";
    onApprove: "merge" | "done";
    defaultAgent: string;
  };
  merge: {
    mode: "auto" | "manual" | "disabled";
    agent?: string;
  };
  review: {
    aiReviewerEnabled: boolean;
    agent: string;
    maxAutoReworks: number;
  };
  retry: {
    enabled: boolean;
    maxAttempts: number;
    backoffSeconds: number;
    backoffMultiplier: number;
    maxBackoffSeconds: number;
    poisonPillThresholdSeconds: number;
  };
  timeouts: {
    runningStaleSeconds: number;
    reviewStaleSeconds: number;
    mergeStaleSeconds: number;
    buildgenStaleSeconds: number;
  };
}

const PRESETS: Record<string, Partial<ResolvedFlow>> = {
  simple: {
    humanApproval: { plan: "disabled", build: "disabled" },
    plan: { onApprove: "done", buildGeneration: "disabled", buildGenerationAgent: "buildgen", defaultAgent: "planner" },
    build: { onSuccess: "done", onApprove: "done", defaultAgent: "builder" },
    merge: { mode: "disabled" },
    review: { aiReviewerEnabled: false, agent: "reviewer", maxAutoReworks: 0 },
    retry: { enabled: false, maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2, maxBackoffSeconds: 300, poisonPillThresholdSeconds: 30 },
  },
  review: {
    humanApproval: { plan: "required", build: "required" },
    plan: { onApprove: "done", buildGeneration: "disabled", buildGenerationAgent: "buildgen", defaultAgent: "planner" },
    build: { onSuccess: "human-review", onApprove: "done", defaultAgent: "builder" },
    merge: { mode: "disabled" },
    review: { aiReviewerEnabled: false, agent: "reviewer", maxAutoReworks: 0 },
    retry: { enabled: false, maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2, maxBackoffSeconds: 300, poisonPillThresholdSeconds: 30 },
  },
  "plan-build": {
    humanApproval: { plan: "required", build: "required" },
    plan: { onApprove: "generate-builds", buildGeneration: "ai", buildGenerationAgent: "buildgen", defaultAgent: "planner" },
    build: { onSuccess: "human-review", onApprove: "done", defaultAgent: "builder" },
    merge: { mode: "disabled" },
    review: { aiReviewerEnabled: false, agent: "reviewer", maxAutoReworks: 0 },
    retry: { enabled: false, maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2, maxBackoffSeconds: 300, poisonPillThresholdSeconds: 30 },
  },
  "plan-build-review-merge": {
    humanApproval: { plan: "required", build: "required" },
    plan: { onApprove: "generate-builds", buildGeneration: "ai", buildGenerationAgent: "buildgen", defaultAgent: "planner" },
    build: { onSuccess: "human-review", onApprove: "merge", defaultAgent: "builder" },
    merge: { mode: "auto" },
    review: { aiReviewerEnabled: false, agent: "reviewer", maxAutoReworks: 2 },
    retry: { enabled: false, maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2, maxBackoffSeconds: 300, poisonPillThresholdSeconds: 30 },
  },
};

const DEFAULT_TIMEOUTS = {
  runningStaleSeconds: 1800,
  reviewStaleSeconds: 600,
  mergeStaleSeconds: 600,
  buildgenStaleSeconds: 600,
};

export function resolveFlow(project: Project): ResolvedFlow {
  const flowConfig = project.spec.flow;
  const presetName = flowConfig?.preset ?? "plan-build-review-merge";
  const preset = PRESETS[presetName] ?? PRESETS["plan-build-review-merge"]!;

  // Legacy policy compatibility.
  const legacyRetry = project.spec.retryPolicy;
  const legacyReview = project.spec.reviewPolicy;

  const flowReview = flowConfig?.review;
  const flowRetry = flowConfig?.retry;
  const flowTimeouts = flowConfig?.timeouts;

  const flowPlan = flowConfig?.plan;
  const flowBuild = flowConfig?.build;
  const flowMerge = flowConfig?.merge;

  return {
    preset: presetName,
    humanApproval: {
      plan: flowConfig?.humanApproval?.plan ?? preset.humanApproval!.plan ?? "required",
      build: flowConfig?.humanApproval?.build ?? preset.humanApproval!.build ?? "required",
    },
    plan: {
      onApprove: flowPlan?.onApprove ?? preset.plan!.onApprove ?? "generate-builds",
      buildGeneration: flowPlan?.buildGeneration ?? preset.plan!.buildGeneration ?? "ai",
      buildGenerationAgent: flowPlan?.buildGenerationAgent ?? preset.plan!.buildGenerationAgent ?? "buildgen",
      defaultAgent: flowPlan?.defaultAgent ?? preset.plan!.defaultAgent ?? "planner",
    },
    build: {
      onSuccess: flowBuild?.onSuccess ?? preset.build!.onSuccess ?? "human-review",
      onApprove: flowBuild?.onApprove ?? preset.build!.onApprove ?? "merge",
      defaultAgent: flowBuild?.defaultAgent ?? preset.build!.defaultAgent ?? "builder",
    },
    merge: {
      mode: flowMerge?.mode ?? preset.merge!.mode ?? "auto",
      agent: flowMerge?.agent,
    },
    review: {
      aiReviewerEnabled: flowReview?.aiReviewerEnabled ?? legacyReview?.aiReviewerEnabled ?? preset.review!.aiReviewerEnabled ?? false,
      agent: flowReview?.agent ?? legacyReview?.aiReviewerAgent ?? preset.review!.agent ?? "reviewer",
      maxAutoReworks: flowReview?.maxAutoReworks ?? legacyReview?.maxAutoReworks ?? preset.review!.maxAutoReworks ?? 2,
    },
    retry: {
      enabled: flowRetry?.enabled ?? legacyRetry?.enabled ?? preset.retry!.enabled ?? false,
      maxAttempts: flowRetry?.maxAttempts ?? legacyRetry?.maxAttempts ?? preset.retry!.maxAttempts ?? 3,
      backoffSeconds: flowRetry?.backoffSeconds ?? legacyRetry?.backoffSeconds ?? preset.retry!.backoffSeconds ?? 30,
      backoffMultiplier: legacyRetry?.backoffMultiplier ?? preset.retry!.backoffMultiplier ?? 2,
      maxBackoffSeconds: legacyRetry?.maxBackoffSeconds ?? preset.retry!.maxBackoffSeconds ?? 300,
      poisonPillThresholdSeconds: legacyRetry?.poisonPillThresholdSeconds ?? preset.retry!.poisonPillThresholdSeconds ?? 30,
    },
    timeouts: {
      runningStaleSeconds: flowTimeouts?.runningStaleSeconds ?? DEFAULT_TIMEOUTS.runningStaleSeconds,
      reviewStaleSeconds: flowTimeouts?.reviewStaleSeconds ?? DEFAULT_TIMEOUTS.reviewStaleSeconds,
      mergeStaleSeconds: flowTimeouts?.mergeStaleSeconds ?? DEFAULT_TIMEOUTS.mergeStaleSeconds,
      buildgenStaleSeconds: flowTimeouts?.buildgenStaleSeconds ?? DEFAULT_TIMEOUTS.buildgenStaleSeconds,
    },
  };
}

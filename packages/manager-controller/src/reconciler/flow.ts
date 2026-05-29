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
  };
  build: {
    onSuccess: "human-review" | "ai-review" | "done";
    onApprove: "merge" | "done";
  };
  merge: {
    mode: "auto" | "manual" | "disabled";
  };
  review: {
    aiReviewerEnabled: boolean;
    aiReviewerAgent: string;
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
    plan: { onApprove: "done", buildGeneration: "disabled" },
    build: { onSuccess: "done", onApprove: "done" },
    merge: { mode: "disabled" },
    review: { aiReviewerEnabled: false, aiReviewerAgent: "reviewer", maxAutoReworks: 0 },
    retry: { enabled: false, maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2, maxBackoffSeconds: 300, poisonPillThresholdSeconds: 30 },
  },
  review: {
    humanApproval: { plan: "required", build: "required" },
    plan: { onApprove: "done", buildGeneration: "disabled" },
    build: { onSuccess: "human-review", onApprove: "done" },
    merge: { mode: "disabled" },
    review: { aiReviewerEnabled: false, aiReviewerAgent: "reviewer", maxAutoReworks: 0 },
    retry: { enabled: false, maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2, maxBackoffSeconds: 300, poisonPillThresholdSeconds: 30 },
  },
  "plan-build": {
    humanApproval: { plan: "required", build: "required" },
    plan: { onApprove: "generate-builds", buildGeneration: "ai" },
    build: { onSuccess: "human-review", onApprove: "done" },
    merge: { mode: "disabled" },
    review: { aiReviewerEnabled: false, aiReviewerAgent: "reviewer", maxAutoReworks: 0 },
    retry: { enabled: false, maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2, maxBackoffSeconds: 300, poisonPillThresholdSeconds: 30 },
  },
  "plan-build-review-merge": {
    humanApproval: { plan: "required", build: "required" },
    plan: { onApprove: "generate-builds", buildGeneration: "ai" },
    build: { onSuccess: "human-review", onApprove: "merge" },
    merge: { mode: "auto" },
    review: { aiReviewerEnabled: false, aiReviewerAgent: "reviewer", maxAutoReworks: 2 },
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

  return {
    preset: presetName,
    humanApproval: {
      plan: flowConfig?.humanApproval?.plan ?? preset.humanApproval!.plan ?? "required",
      build: flowConfig?.humanApproval?.build ?? preset.humanApproval!.build ?? "required",
    },
    plan: {
      onApprove: flowConfig?.plan?.onApprove ?? preset.plan!.onApprove ?? "generate-builds",
      buildGeneration: flowConfig?.plan?.buildGeneration ?? preset.plan!.buildGeneration ?? "ai",
    },
    build: {
      onSuccess: flowConfig?.build?.onSuccess ?? preset.build!.onSuccess ?? "human-review",
      onApprove: flowConfig?.build?.onApprove ?? preset.build!.onApprove ?? "merge",
    },
    merge: {
      mode: flowConfig?.merge?.mode ?? preset.merge!.mode ?? "auto",
    },
    review: {
      aiReviewerEnabled: flowReview?.aiReviewerEnabled ?? legacyReview?.aiReviewerEnabled ?? preset.review!.aiReviewerEnabled ?? false,
      aiReviewerAgent: flowReview?.aiReviewerAgent ?? legacyReview?.aiReviewerAgent ?? preset.review!.aiReviewerAgent ?? "reviewer",
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

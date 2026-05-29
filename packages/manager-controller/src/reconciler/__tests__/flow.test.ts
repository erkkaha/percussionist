import { describe, it, expect } from "vitest";
import { resolveFlow } from "../flow.js";
import { makeProject } from "./fixtures.js";

describe("resolveFlow", () => {
  it("resolves plan-build-review-merge preset by default", () => {
    const project = makeProject("test-project");
    const flow = resolveFlow(project);
    expect(flow.preset).toBe("plan-build-review-merge");
    expect(flow.plan.onApprove).toBe("generate-builds");
    expect(flow.build.onApprove).toBe("merge");
    expect(flow.merge.mode).toBe("auto");
    expect(flow.humanApproval.plan).toBe("required");
    expect(flow.humanApproval.build).toBe("required");
  });

  it("resolves simple preset", () => {
    const project = makeProject("test-project");
    project.spec.flow = { preset: "simple" };
    const flow = resolveFlow(project);
    expect(flow.preset).toBe("simple");
    expect(flow.plan.onApprove).toBe("done");
    expect(flow.build.onApprove).toBe("done");
    expect(flow.merge.mode).toBe("disabled");
    expect(flow.humanApproval.plan).toBe("disabled");
    expect(flow.humanApproval.build).toBe("disabled");
  });

  it("resolves review preset", () => {
    const project = makeProject("test-project");
    project.spec.flow = { preset: "review" };
    const flow = resolveFlow(project);
    expect(flow.preset).toBe("review");
    expect(flow.plan.onApprove).toBe("done");
    expect(flow.build.onSuccess).toBe("human-review");
    expect(flow.build.onApprove).toBe("done");
    expect(flow.merge.mode).toBe("disabled");
    expect(flow.humanApproval.build).toBe("required");
  });

  it("resolves plan-build preset", () => {
    const project = makeProject("test-project");
    project.spec.flow = { preset: "plan-build" };
    const flow = resolveFlow(project);
    expect(flow.preset).toBe("plan-build");
    expect(flow.plan.onApprove).toBe("generate-builds");
    expect(flow.build.onApprove).toBe("done");
    expect(flow.merge.mode).toBe("disabled");
  });

  it("overrides preset defaults with flow config", () => {
    const project = makeProject("test-project");
    project.spec.flow = {
      preset: "plan-build-review-merge",
      build: { onApprove: "done", onSuccess: "human-review" },
      merge: { mode: "disabled" },
    };
    const flow = resolveFlow(project);
    expect(flow.preset).toBe("plan-build-review-merge");
    expect(flow.build.onApprove).toBe("done");
    expect(flow.merge.mode).toBe("disabled");
    expect(flow.plan.onApprove).toBe("generate-builds");
  });

  it("merges legacy retryPolicy into flow.retry", () => {
    const project = makeProject("test-project", {
      retryPolicy: {
        enabled: true,
        maxAttempts: 5,
        backoffSeconds: 60,
      },
    });
    const flow = resolveFlow(project);
    expect(flow.retry.enabled).toBe(true);
    expect(flow.retry.maxAttempts).toBe(5);
    expect(flow.retry.backoffSeconds).toBe(60);
    expect(flow.retry.backoffMultiplier).toBe(2);
    expect(flow.retry.maxBackoffSeconds).toBe(300);
  });

  it("merges legacy reviewPolicy into flow.review", () => {
    const project = makeProject("test-project", {
      reviewPolicy: {
        aiReviewerEnabled: true,
        aiReviewerAgent: "custom-reviewer",
        maxAutoReworks: 5,
      },
    });
    const flow = resolveFlow(project);
    expect(flow.review.aiReviewerEnabled).toBe(true);
    expect(flow.review.aiReviewerAgent).toBe("custom-reviewer");
    expect(flow.review.maxAutoReworks).toBe(5);
  });

  it("flow.review overrides legacy reviewPolicy", () => {
    const project = makeProject("test-project", {
      reviewPolicy: {
        aiReviewerEnabled: true,
        aiReviewerAgent: "legacy-reviewer",
        maxAutoReworks: 5,
      },
    });
    project.spec.flow = {
      preset: "plan-build-review-merge",
      review: {
        aiReviewerEnabled: false,
        aiReviewerAgent: "new-reviewer",
        maxAutoReworks: 1,
      },
    };
    const flow = resolveFlow(project);
    expect(flow.review.aiReviewerEnabled).toBe(false);
    expect(flow.review.aiReviewerAgent).toBe("new-reviewer");
    expect(flow.review.maxAutoReworks).toBe(1);
  });

  it("flow.retry overrides legacy retryPolicy", () => {
    const project = makeProject("test-project", {
      retryPolicy: {
        enabled: true,
        maxAttempts: 5,
        backoffSeconds: 60,
      },
    });
    project.spec.flow = {
      preset: "plan-build-review-merge",
      retry: {
        enabled: false,
        maxAttempts: 2,
        backoffSeconds: 10,
        backoffMultiplier: 1,
        maxBackoffSeconds: 60,
        poisonPillThresholdSeconds: 10,
      },
    };
    const flow = resolveFlow(project);
    expect(flow.retry.enabled).toBe(false);
    expect(flow.retry.maxAttempts).toBe(2);
    expect(flow.retry.backoffSeconds).toBe(10);
  });

  it("uses default timeouts when not configured", () => {
    const project = makeProject("test-project");
    const flow = resolveFlow(project);
    expect(flow.timeouts.runningStaleSeconds).toBe(1800);
    expect(flow.timeouts.reviewStaleSeconds).toBe(600);
    expect(flow.timeouts.mergeStaleSeconds).toBe(600);
    expect(flow.timeouts.buildgenStaleSeconds).toBe(600);
  });

  it("overrides timeouts from flow config", () => {
    const project = makeProject("test-project");
    project.spec.flow = {
      preset: "plan-build-review-merge",
      timeouts: {
        runningStaleSeconds: 3600,
        reviewStaleSeconds: 1200,
        mergeStaleSeconds: 900,
        buildgenStaleSeconds: 1800,
      },
    };
    const flow = resolveFlow(project);
    expect(flow.timeouts.runningStaleSeconds).toBe(3600);
    expect(flow.timeouts.reviewStaleSeconds).toBe(1200);
    expect(flow.timeouts.mergeStaleSeconds).toBe(900);
    expect(flow.timeouts.buildgenStaleSeconds).toBe(1800);
  });
});

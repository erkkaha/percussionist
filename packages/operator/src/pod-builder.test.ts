// pod-builder.test.ts — Tests for workspace-init shell script generation

/**
 * Tests for pod-builder.ts rendered script content.
 * 
 * These tests verify that the workspace-init init container generates
 * correct shell scripts with parent-baseline resolution logic.
 * 
 * Manual verification notes:
 * - Run `bun test` to execute these unit tests
 * - Verify generated shell script contains `_PARENT_REMOTE_REF` and `_PARENT_BASE_REF`
 * - Check both worktreeReuse=true and worktreeReuse=false code paths have identical logic
 * - Log messages should show "using remote-tracking ref" or "falling back to local ref"
 */

import { describe, it, expect } from "bun:test";
import type { Run } from "@percussionist/api";
import { renderPod } from "./pod-builder.js";

// Helper to create a minimal Run CR with all required fields
function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    apiVersion: "percussionist.dev/v1alpha1",
    kind: "Run",
    metadata: {
      name: "test-run-123",
      namespace: "test-ns",
      uid: "test-uid-123",
      labels: { "percussionist.dev/project": "test-project" },
      creationTimestamp: new Date().toISOString(),
    },
    spec: {
      project: "test-project",
      task: "test-task",
      interactive: false,
      ttlSecondsAfterFinished: 604800, // 7 days
      source: { 
        git: { 
          url: "https://github.com/test/repo.git", 
          ref: "main" 
        } 
      },
      image: "ghcr.io/erkkaha/percussionist/runner:latest",
      timeoutSeconds: 3600,
    },
    status: {} as any,
    ...overrides,
  } as Run;
}

// Helper to extract the workspace-init init container
function getWorkspaceInitContainer(run: Run) {
  const pod = renderPod(run, []);
  return pod.spec?.initContainers?.find((c) => c.name === "workspace-init");
}

// Helper to extract and join the args of the workspace-init container
function getWorkspaceInitArgs(run: Run): string {
  const container = getWorkspaceInitContainer(run);
  if (!container || !container.args || container.args.length === 0) {
    throw new Error("No workspace-init container found or no args");
  }
  // The args is an array of strings that get joined by \n
  return Array.isArray(container.args)
    ? (container.args as string[]).join("\n")
    : String(container.args);
}

describe("renderPod - workspace-init script generation", () => {
  describe("remote git with worktreeReuse=true (default)", () => {
    it("should generate worktree creation with parent baseline resolution when creating new branch from parentRef", () => {
      const run = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "feature/child-branch",
              parentRef: "feature/my-feature"
            } 
          },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // When git.ref is set but the branch doesn't exist and parentRef is provided,
      // the script should use parentBaselineResolve helper
      expect(args).toContain("refs/remotes/origin/");
      expect(args).toContain("_PARENT_REMOTE_REF=");
      expect(args).toContain("_PARENT_BASE_REF=");
    });

    it("should use remote-tracking ref when creating branch from parentRef", () => {
      const run = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "feature/child-branch",
              parentRef: "feature/my-feature"
            } 
          },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // The script should include logic to prefer remote-tracking ref
      expect(args).toMatch(/_PARENT_REMOTE_REF="refs\/remotes\/origin\/[^"]+"/);
    });
  });

  describe("remote git with freshWorktree (worktreeReuse=false)", () => {
    it("should generate worktree creation with parent baseline resolution when creating new branch from parentRef", () => {
      const run = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "feature/child-branch",
              parentRef: "feature/my-feature"
            } 
          },
        },
      });

      // Override to use freshWorktree mode
      (run.spec as any).gitCache = { worktreeReuse: false };

      const args = getWorkspaceInitArgs(run);

      // Should include parent baseline resolution in freshWorktree mode
      expect(args).toContain("refs/remotes/origin/");
      expect(args).toContain("_PARENT_REMOTE_REF=");
      expect(args).toContain("_PARENT_BASE_REF=");
    });

    it("should use remote-tracking ref when creating branch from parentRef in freshWorktree mode", () => {
      const run = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "feature/child-branch",
              parentRef: "feature/my-feature"
            } 
          },
        },
      });

      // Override to use freshWorktree mode
      (run.spec as any).gitCache = { worktreeReuse: false };

      const args = getWorkspaceInitArgs(run);

      // The script should include logic to prefer remote-tracking ref
      expect(args).toMatch(/_PARENT_REMOTE_REF="refs\/remotes\/origin\/[^"]+"/);
    });
  });

  describe("no parentRef scenario", () => {
    it("should work without parentRef (plain branch creation)", () => {
      const run = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "main"
            } 
          },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // Should NOT contain parent baseline resolution when no parentRef
      expect(args).not.toContain("_PARENT_REMOTE_REF");
      expect(args).not.toContain("_PARENT_BASE_REF");
    });
  });

  describe("local git mode", () => {
    it("should generate local workspace init script without remote refs", () => {
      const run = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { local: true },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // Local git mode should not reference remote-tracking branches
      expect(args).not.toContain("refs/remotes/origin/");
      expect(args).not.toContain("_PARENT_REMOTE_REF");
      expect(args).toContain("git init \"$WORKSPACE_DIR\"");
    });
  });

  describe("both worktreeReuse and freshWorktree paths have identical parent-baseline logic", () => {
    it("should use the same parent baseline resolution pattern in both modes", () => {
      const runReuse = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "feature/child-branch",
              parentRef: "feature/my-feature"
            } 
          },
        },
      });

      const runFresh = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "feature/child-branch",
              parentRef: "feature/my-feature"
            } 
          },
        },
      });

      // Override to use freshWorktree mode
      (runFresh.spec as any).gitCache = { worktreeReuse: false };

      const argsReuse = getWorkspaceInitArgs(runReuse);
      const argsFresh = getWorkspaceInitArgs(runFresh);

      // Both should contain the same parent baseline resolution pattern
      expect(argsReuse).toContain("_PARENT_REMOTE_REF=\"refs/remotes/origin/");
      expect(argsFresh).toContain("_PARENT_REMOTE_REF=\"refs/remotes/origin/");

      // Extract and compare the key resolution logic
      const reuseHasResolution = argsReuse.includes("_PARENT_BASE_REF=");
      const freshHasResolution = argsFresh.includes("_PARENT_BASE_REF=");

      expect(reuseHasResolution).toBe(true);
      expect(freshHasResolution).toBe(true);
    });
  });

  describe("log messages for parent baseline resolution", () => {
    it("should include log message when using remote-tracking ref as parent baseline", () => {
      const run = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "feature/child-branch",
              parentRef: "feature/my-feature"
            } 
          },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // Should have log for using remote ref
      expect(args).toContain("using remote-tracking ref");
    });

    it("should include fallback log message when falling back to local ref", () => {
      const run = makeRun({
        spec: {
          project: "test-project",
          task: "build-task-1",
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { 
            git: { 
              url: "https://github.com/test/repo.git", 
              ref: "feature/child-branch",
              parentRef: "feature/my-feature"
            } 
          },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // Should have log for fallback
      expect(args).toContain("falling back to local ref");
    });
  });
});

import { describe, it, expect } from "bun:test";
import { resolveRunConfig } from "../index.js";
import type { ProjectSpec, ResourceRequirements } from "../index.js";

describe("resolveRunConfig", () => {
  const defaultImage = "ghcr.io/erkkaha/percussionist/runner:latest";
  const defaultTimeout = 3600;

  const baseProject: ProjectSpec = {
    model: "gpt-4",
    image: "my-project-image",
    timeoutSeconds: 1800,
    resources: { requests: { cpu: "500m", memory: "512Mi" } },
    source: { git: { url: "https://github.com/test/repo.git" } },
  };

  const baseBoard = { model: "board-model", image: "board-image", timeoutSeconds: 900, resources: { requests: { cpu: "200m" } } as ResourceRequirements };
  const baseRun = { model: "run-model", image: "run-image", timeoutSeconds: 300, resources: { requests: { memory: "256Mi" } } as ResourceRequirements };
  const baseCluster = { runner: { image: "cluster-image", timeoutSeconds: 7200, resources: { requests: { cpu: "100m" } } as ResourceRequirements }, secrets: undefined };

  it("runOverrides take precedence over everything", () => {
    const result = resolveRunConfig(baseProject, baseBoard, baseRun, baseCluster);
    expect(result.model).toBe("run-model");
    expect(result.image).toBe("run-image");
    expect(result.timeoutSeconds).toBe(300);
    expect(result.resources).toEqual({ requests: { memory: "256Mi" } });
  });

  it("boardOverrides take precedence over project and cluster", () => {
    const result = resolveRunConfig(baseProject, baseBoard, undefined, baseCluster);
    expect(result.model).toBe("board-model");
    expect(result.image).toBe("board-image");
    expect(result.timeoutSeconds).toBe(900);
    expect(result.resources).toEqual({ requests: { cpu: "200m" } });
  });

  it("project defaults fill gaps when no run/board overrides", () => {
    const result = resolveRunConfig(baseProject, undefined, undefined, baseCluster);
    expect(result.model).toBe("gpt-4");
    expect(result.image).toBe("my-project-image");
    expect(result.timeoutSeconds).toBe(1800);
    expect(result.resources).toEqual({ requests: { cpu: "500m", memory: "512Mi" } });
    expect(result.source).toEqual({ git: { url: "https://github.com/test/repo.git" } });
  });

  it("clusterBase is the lowest priority fallback", () => {
    const minimalProject: ProjectSpec = { source: { git: { url: "https://github.com/test/repo.git" } } };
    const result = resolveRunConfig(minimalProject, undefined, undefined, baseCluster);
    expect(result.model).toBeUndefined();
    expect(result.image).toBe("cluster-image");
    expect(result.timeoutSeconds).toBe(7200);
    expect(result.resources).toEqual({ requests: { cpu: "100m" } });
  });

  it("uses hardcoded defaults when nothing is set", () => {
    const minimalProject: ProjectSpec = { source: { git: { url: "https://github.com/test/repo.git" } } };
    const result = resolveRunConfig(minimalProject);
    expect(result.image).toBe(defaultImage);
    expect(result.timeoutSeconds).toBe(defaultTimeout);
    expect(result.resources).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it("partial board overrides fill only those fields", () => {
    const project: ProjectSpec = { model: "gpt-4", timeoutSeconds: 1800, source: { git: { url: "https://github.com/test/repo.git" } } };
    const boardPartial = { timeoutSeconds: 42 } as { model?: string; image?: string; timeoutSeconds?: number; resources?: ResourceRequirements };
    const result = resolveRunConfig(project, boardPartial);
    expect(result.model).toBe("gpt-4");           // from project
    expect(result.timeoutSeconds).toBe(42);        // from board (overrides project)
    expect(result.image).toBe(defaultImage);       // not set anywhere → default
  });

  it("secrets cascade: run > project > cluster", () => {
    const clusterSecrets = { secrets: { githubToken: "cluster" } as Record<string, string> };
    const resultNoOverrides = resolveRunConfig(
      { source: { git: { url: "https://github.com/test/repo.git" } } } as ProjectSpec,
      undefined,
      undefined,
      { runner: undefined, secrets: { githubToken: "cluster" } },
    );
    expect(resultNoOverrides.secrets?.githubToken).toBe("cluster");

    const resultProject = resolveRunConfig(
      { ...baseProject, secrets: { githubToken: "project" } },
      undefined,
      undefined,
      { runner: undefined, secrets: { githubToken: "cluster" } },
    );
    expect(resultProject.secrets?.githubToken).toBe("project");

    const resultRun = resolveRunConfig(
      { ...baseProject, secrets: { githubToken: "project" } },
      undefined,
      { secrets: { githubToken: "run" } },
      { runner: undefined, secrets: { githubToken: "cluster" } },
    );
    expect(resultRun.secrets?.githubToken).toBe("run");
  });
});

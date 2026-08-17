// memory-service.test.ts — per-project memory service renderers (C15).
//
// The memory service renders the embedding vector store for a project. Its
// env keys (Ollama URL, model, dimensions, MCP token), PVC volume wiring and
// owner references were never asserted anywhere — a changed env key silently
// breaks agent context injection for every project. These tests pin the
// rendered Deployment/Service shapes.

import { describe, expect, it } from 'bun:test';
import type { Project } from '@percussionist/api';
import {
  memoryServiceDeploymentName,
  memoryServiceServiceName,
  renderMemoryServiceDeployment,
  renderMemoryServiceService,
  shouldReconcileMemoryService,
} from './memory-service.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: {
      name: 'demo-project',
      namespace: 'team-a',
      uid: 'project-uid-1',
    },
    spec: {
      source: { local: true },
      embedding: { enabled: true },
    },
    status: {},
    ...overrides,
  } as Project;
}

function memoryContainer(dep: ReturnType<typeof renderMemoryServiceDeployment>) {
  const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'memory');
  if (!container) throw new Error('memory container missing');
  return container;
}

function envOf(dep: ReturnType<typeof renderMemoryServiceDeployment>, name: string) {
  const env = memoryContainer(dep).env ?? [];
  const entry = env.find((e) => e.name === name);
  if (!entry) throw new Error(`env var ${name} missing`);
  return entry;
}

describe('shouldReconcileMemoryService', () => {
  it('requires embedding.enabled', () => {
    expect(shouldReconcileMemoryService(makeProject({ spec: { source: { local: true } } }))).toBe(
      false,
    );
  });

  it('requires a data PVC source (git or local)', () => {
    expect(
      shouldReconcileMemoryService(makeProject({ spec: { embedding: { enabled: true } } })),
    ).toBe(false);
  });

  it('enables with embedding.enabled + source.local', () => {
    expect(shouldReconcileMemoryService(makeProject())).toBe(true);
  });

  it('enables with embedding.enabled + source.git', () => {
    expect(
      shouldReconcileMemoryService(
        makeProject({
          spec: {
            source: { git: { url: 'https://github.com/example/repo.git' } },
            embedding: { enabled: true },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('renderMemoryServiceDeployment', () => {
  it('names, namespaces and labels the Deployment', () => {
    const dep = renderMemoryServiceDeployment(makeProject());
    expect(dep.metadata.name).toBe(memoryServiceDeploymentName(makeProject()));
    expect(dep.metadata.name).toBe('memory-demo-project');
    expect(dep.metadata.namespace).toBe('team-a');
    expect(dep.metadata.labels?.['percussionist.dev/component']).toBe('memory-service');
    expect(dep.metadata.labels?.['percussionist.dev/project']).toBe('demo-project');
  });

  it('wires the expected env keys onto the memory container', () => {
    const dep = renderMemoryServiceDeployment(makeProject());
    const env = memoryContainer(dep).env ?? [];
    const names = env.map((e) => e.name).sort();
    expect(names).toEqual(
      [
        'EMBEDDING_DIMENSIONS',
        'EMBEDDING_MODEL',
        'MCP_TOKEN',
        'MEMORY_DB_PATH',
        'MEMORY_SERVICE_PORT',
        'OLLAMA_BASE_URL',
      ].sort(),
    );
  });

  it('sets the embedding model, dimensions and Ollama URL from the spec', () => {
    const dep = renderMemoryServiceDeployment(
      makeProject({
        spec: {
          source: { local: true },
          embedding: {
            enabled: true,
            model: 'nomic-embed-text',
            dimensions: 1024,
            ollamaUrl: 'http://ollama.internal:11434',
          },
        },
      }),
    );
    expect(envOf(dep, 'EMBEDDING_MODEL').value).toBe('nomic-embed-text');
    expect(envOf(dep, 'EMBEDDING_DIMENSIONS').value).toBe('1024');
    expect(envOf(dep, 'OLLAMA_BASE_URL').value).toBe('http://ollama.internal:11434');
  });

  it('applies defaults for dimensions, Ollama URL and the DB path on the default mount', () => {
    const dep = renderMemoryServiceDeployment(
      makeProject({
        spec: { source: { local: true }, embedding: { enabled: true, model: 'nomic-embed-text' } },
      }),
    );
    expect(envOf(dep, 'EMBEDDING_DIMENSIONS').value).toBe('768');
    expect(envOf(dep, 'OLLAMA_BASE_URL').value).toBe(
      'http://ollama.percussionist.svc.cluster.local:11434',
    );
    expect(envOf(dep, 'MEMORY_DB_PATH').value).toBe('/data/memory/vectors.db');
  });

  it('mounts the memory DB under the overridden mountPath', () => {
    const dep = renderMemoryServiceDeployment(
      makeProject({
        spec: {
          source: { local: true },
          data: { mountPath: '/custom-data' },
          embedding: { enabled: true, model: 'm' },
        },
      }),
    );
    expect(envOf(dep, 'MEMORY_DB_PATH').value).toBe('/custom-data/memory/vectors.db');
    expect(memoryContainer(dep).volumeMounts?.[0]?.mountPath).toBe('/custom-data');
  });

  it('references the MCP token secret as an optional secretKeyRef (control-plane gating)', () => {
    const dep = renderMemoryServiceDeployment(makeProject());
    const entry = envOf(dep, 'MCP_TOKEN');
    expect(entry.valueFrom).toEqual({
      secretKeyRef: { name: 'manager-mcp-token', key: 'token', optional: true },
    });
  });

  it('claims the project data PVC (honoring spec.data.pvcName)', () => {
    const defaultDep = renderMemoryServiceDeployment(makeProject());
    expect(defaultDep.spec?.template.spec?.volumes?.[0]?.persistentVolumeClaim?.claimName).toBe(
      'demo-project-data',
    );

    const overridden = renderMemoryServiceDeployment(
      makeProject({
        spec: {
          source: { local: true },
          data: { pvcName: 'custom-pvc' },
          embedding: { enabled: true, model: 'm' },
        },
      }),
    );
    expect(overridden.spec?.template.spec?.volumes?.[0]?.persistentVolumeClaim?.claimName).toBe(
      'custom-pvc',
    );
  });

  it('uses IfNotPresent pull policy so locally built images work', () => {
    const dep = renderMemoryServiceDeployment(makeProject());
    expect(memoryContainer(dep).imagePullPolicy).toBe('IfNotPresent');
  });

  it('mounts a readiness probe on /health with a model-pull grace period', () => {
    const dep = renderMemoryServiceDeployment(makeProject());
    const probe = memoryContainer(dep).readinessProbe;
    expect(probe?.httpGet?.path).toBe('/health');
    expect(probe?.httpGet?.port).toBe(4100);
    expect(probe?.initialDelaySeconds).toBe(10);
    expect(probe?.failureThreshold).toBe(12);
  });

  it('sets an owner reference that ties the Deployment lifecycle to the Project', () => {
    const dep = renderMemoryServiceDeployment(makeProject());
    expect(dep.metadata.ownerReferences).toEqual([
      {
        apiVersion: 'percussionist.dev/v1alpha1',
        kind: 'Project',
        name: 'demo-project',
        uid: 'project-uid-1',
        controller: true,
        blockOwnerDeletion: true,
      },
    ]);
  });

  it('throws when embedding config is missing (renderer guard for misused renderers)', () => {
    const project = makeProject({ spec: { source: { local: true } } });
    expect(() => renderMemoryServiceDeployment(project)).toThrow('embedding config is required');
  });
});

describe('renderMemoryServiceService', () => {
  it('renders a ClusterIP Service selecting the memory-service pods on the memory port', () => {
    const svc = renderMemoryServiceService(makeProject());
    expect(svc.metadata.name).toBe(memoryServiceServiceName(makeProject()));
    expect(svc.metadata.namespace).toBe('team-a');
    expect(svc.spec?.type).toBe('ClusterIP');
    expect(svc.spec?.selector).toEqual({
      'percussionist.dev/project': 'demo-project',
      'percussionist.dev/component': 'memory-service',
    });
    expect(svc.spec?.ports).toEqual([
      { port: 4100, targetPort: 4100, name: 'http', protocol: 'TCP' },
    ]);
  });

  it('sets an owner reference tying the Service lifecycle to the Project', () => {
    const svc = renderMemoryServiceService(makeProject());
    expect(svc.metadata.ownerReferences).toEqual([
      {
        apiVersion: 'percussionist.dev/v1alpha1',
        kind: 'Project',
        name: 'demo-project',
        uid: 'project-uid-1',
        controller: true,
        blockOwnerDeletion: true,
      },
    ]);
  });
});

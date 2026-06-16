import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Finding, Project } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import * as memoryClient from '../../agent/memory-client.js';
import * as events from '../../events.js';
import { ingestFindings } from '../findings-ingestion.js';

const namespace = 'percussionist';

const makeProject = (overrides?: {
  embeddingEnabled?: boolean;
  agents?: Array<{ name: string }>;
}): Project =>
  ({
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: 'test-project', namespace, uid: 'uid-test-project' },
    spec: {
      maxParallel: 2,
      ...(overrides?.agents ? { agents: overrides.agents } : {}),
      ...(overrides?.embeddingEnabled !== undefined
        ? { embedding: { enabled: overrides.embeddingEnabled } }
        : {}),
    },
  }) as Project;

const makeInboxFinding = (overrides: Partial<Finding> & { id: string }): Finding => ({
  id: overrides.id,
  title: overrides.title ?? 'Test finding',
  description: overrides.description ?? 'Something wrong',
  severity: overrides.severity ?? 'medium',
  category: overrides.category ?? 'bug',
  source: overrides.source ?? {
    project: 'test-project',
    task: 'task-1',
    run: 'run-1',
    agent: 'builder',
  },
  dedupKey: overrides.dedupKey ?? 'dk-1',
  occurrences: overrides.occurrences ?? 1,
  createdAt: overrides.createdAt ?? '2026-06-15T00:00:00.000Z',
  ...(overrides.filePath ? { filePath: overrides.filePath } : {}),
  ...(overrides.snippet ? { snippet: overrides.snippet } : {}),
  ...(overrides.status ? { status: overrides.status } : {}),
  ...(overrides.clusterId ? { clusterId: overrides.clusterId } : {}),
  ...(overrides.triagedAt ? { triagedAt: overrides.triagedAt } : {}),
  ...(overrides.taskRef ? { taskRef: overrides.taskRef } : {}),
  ...(overrides.duplicateOf ? { duplicateOf: overrides.duplicateOf } : {}),
});

const makeTriagedFinding = (
  overrides: Partial<Finding> & { id: string; clusterId: string },
): Finding => ({
  ...makeInboxFinding(overrides),
  status: overrides.status ?? 'triaged',
  clusterId: overrides.clusterId,
  triagedAt: overrides.triagedAt ?? '2026-06-14T00:00:00.000Z',
});

let getFindingsConfigMapSpy: ReturnType<typeof spyOn>;
let parseInboxFindingsSpy: ReturnType<typeof spyOn>;
let parseTriagedFindingsSpy: ReturnType<typeof spyOn>;
let patchFindingsConfigMapSpy: ReturnType<typeof spyOn>;
let patchProjectStatusSpy: ReturnType<typeof spyOn>;
let buildTaskSpy: ReturnType<typeof spyOn>;
let createTaskSpy: ReturnType<typeof spyOn>;
let patchTaskSpy: ReturnType<typeof spyOn>;
let patchTaskStatusSpy: ReturnType<typeof spyOn>;
let queryMemorySpy: ReturnType<typeof spyOn>;
let storeMemorySpy: ReturnType<typeof spyOn>;
let emitEventSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  getFindingsConfigMapSpy = spyOn(kube, 'getFindingsConfigMap');
  parseInboxFindingsSpy = spyOn(kube, 'parseInboxFindings');
  parseTriagedFindingsSpy = spyOn(kube, 'parseTriagedFindings');
  patchFindingsConfigMapSpy = spyOn(kube, 'patchFindingsConfigMap').mockResolvedValue(undefined);
  patchProjectStatusSpy = spyOn(kube, 'patchProjectStatus').mockResolvedValue(undefined);
  buildTaskSpy = spyOn(kube, 'buildTask').mockReturnValue({} as any);
  createTaskSpy = spyOn(kube, 'createTask').mockResolvedValue({} as any);
  patchTaskSpy = spyOn(kube, 'patchTask').mockResolvedValue({} as any);
  patchTaskStatusSpy = spyOn(kube, 'patchTaskStatus').mockResolvedValue(undefined as any);
  queryMemorySpy = spyOn(memoryClient, 'queryMemory').mockResolvedValue([]);
  storeMemorySpy = spyOn(memoryClient, 'storeMemory').mockResolvedValue(undefined as any);
  emitEventSpy = spyOn(events, 'emitEvent').mockImplementation(() => {});
});

afterEach(() => {
  getFindingsConfigMapSpy.mockRestore();
  parseInboxFindingsSpy.mockRestore();
  parseTriagedFindingsSpy.mockRestore();
  patchFindingsConfigMapSpy.mockRestore();
  patchProjectStatusSpy.mockRestore();
  buildTaskSpy.mockRestore();
  createTaskSpy.mockRestore();
  patchTaskSpy.mockRestore();
  patchTaskStatusSpy.mockRestore();
  queryMemorySpy.mockRestore();
  storeMemorySpy.mockRestore();
  emitEventSpy.mockRestore();
});

function setupConfigMap(inbox: Finding[], triaged: Finding[] = []) {
  const data: Record<string, string> = {};
  for (const f of inbox) {
    data[`inbox/${f.id}.json`] = JSON.stringify(f);
  }
  for (const f of triaged) {
    const key = f.clusterId ?? f.id;
    data[`triaged/${key}.json`] = JSON.stringify(f);
  }
  getFindingsConfigMapSpy.mockResolvedValue(data);
  parseInboxFindingsSpy.mockImplementation((d: Record<string, string>) => {
    const findings: Finding[] = [];
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith('inbox/') && k.endsWith('.json')) {
        try {
          findings.push(JSON.parse(v));
        } catch {
          /* skip */
        }
      }
    }
    findings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return findings;
  });
  parseTriagedFindingsSpy.mockImplementation((d: Record<string, string>) => {
    const map = new Map<string, Finding>();
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith('triaged/') && k.endsWith('.json')) {
        try {
          const f = JSON.parse(v) as Finding;
          if (f.clusterId) map.set(f.clusterId, f);
        } catch {
          /* skip */
        }
      }
    }
    return map;
  });
}

describe('ingestFindings', () => {
  it('returns early when ConfigMap does not exist', async () => {
    getFindingsConfigMapSpy.mockResolvedValue(null);
    const project = makeProject();
    await ingestFindings(project, namespace);
    expect(patchFindingsConfigMapSpy).not.toHaveBeenCalled();
    expect(patchProjectStatusSpy).not.toHaveBeenCalled();
  });

  it('returns early when inbox is empty', async () => {
    setupConfigMap([]);
    const project = makeProject();
    await ingestFindings(project, namespace);
    expect(patchFindingsConfigMapSpy).not.toHaveBeenCalled();
    expect(patchProjectStatusSpy).not.toHaveBeenCalled();
  });

  it('triages a new finding and patches ConfigMap', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-1' });
    setupConfigMap([f1]);

    const project = makeProject();
    await ingestFindings(project, namespace);

    expect(patchFindingsConfigMapSpy).toHaveBeenCalledTimes(1);
    const patchArg = patchFindingsConfigMapSpy.mock.calls[0]![1] as Record<string, string | null>;
    expect(patchArg[`triaged/f1.json`]).toBeDefined();
    expect(patchArg[`inbox/f1.json`]).toBeNull();

    const triaged = JSON.parse(patchArg[`triaged/f1.json`]!);
    expect(triaged.status).toBe('triaged');
    expect(triaged.clusterId).toBe('f1');
    expect(triaged.id).toBe('f1');

    expect(patchProjectStatusSpy).toHaveBeenCalledTimes(1);
    const statusArg = patchProjectStatusSpy.mock.calls[0]![1] as { board: { findings: Finding[] } };
    expect(statusArg.board.findings).toHaveLength(1);
    expect(statusArg.board.findings[0]!.status).toBe('triaged');
  });

  it('deduplicates by exact dedupKey (Layer 1)', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-same' });
    const existing = makeTriagedFinding({
      id: 'f0',
      clusterId: 'c0',
      dedupKey: 'dk-same',
      occurrences: 1,
    });
    setupConfigMap([f1], [existing]);

    const project = makeProject();
    await ingestFindings(project, namespace);

    expect(patchFindingsConfigMapSpy).toHaveBeenCalledTimes(1);
    const patchArg = patchFindingsConfigMapSpy.mock.calls[0]![1] as Record<string, string | null>;
    expect(patchArg[`inbox/f1.json`]).toBeNull();
    expect(patchArg[`triaged/c0.json`]).toBeDefined();
    const updatedTriaged = JSON.parse(patchArg[`triaged/c0.json`]!);
    expect(updatedTriaged.occurrences).toBe(2);
  });

  it('deduplicates by file+snippet hash (Layer 2)', async () => {
    const f1 = makeInboxFinding({
      id: 'f1',
      dedupKey: 'dk-new',
      filePath: 'src/worker.ts',
      snippet: 'const buf = Buffer.alloc(1024);',
    });
    const existing = makeTriagedFinding({
      id: 'f0',
      clusterId: 'c0',
      dedupKey: 'dk-old',
      filePath: 'src/worker.ts',
      snippet: 'const buf = Buffer.alloc(1024);',
      occurrences: 1,
    });
    setupConfigMap([f1], [existing]);

    const project = makeProject();
    await ingestFindings(project, namespace);

    const patchArg = patchFindingsConfigMapSpy.mock.calls[0]![1] as Record<string, string | null>;
    expect(patchArg[`inbox/f1.json`]).toBeNull();
    const updatedTriaged = JSON.parse(patchArg[`triaged/c0.json`]!);
    expect(updatedTriaged.occurrences).toBe(2);
  });

  it('deduplicates by semantic similarity (Layer 3) when embedding enabled', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-new' });
    const existing = makeTriagedFinding({
      id: 'f0',
      clusterId: 'c0',
      dedupKey: 'dk-old',
    });
    setupConfigMap([f1], [existing]);

    queryMemorySpy.mockResolvedValue([
      {
        id: 'mem1',
        content: 'similar',
        distance: 0.1,
        metadata: { kind: 'finding', clusterId: 'c0' },
      },
    ]);

    const project = makeProject({ embeddingEnabled: true });
    await ingestFindings(project, namespace);

    const patchArg = patchFindingsConfigMapSpy.mock.calls[0]![1] as Record<string, string | null>;
    expect(patchArg[`inbox/f1.json`]).toBeNull();
    const updatedTriaged = JSON.parse(patchArg[`triaged/c0.json`]!);
    expect(updatedTriaged.occurrences).toBe(2);
  });

  it('does not deduplicate by semantic similarity when embedding is disabled', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-new' });
    const existing = makeTriagedFinding({
      id: 'f0',
      clusterId: 'c0',
      dedupKey: 'dk-old',
    });
    setupConfigMap([f1], [existing]);

    const project = makeProject({ embeddingEnabled: false });
    await ingestFindings(project, namespace);

    const patchArg = patchFindingsConfigMapSpy.mock.calls[0]![1] as Record<string, string | null>;
    expect(patchArg[`triaged/f1.json`]).toBeDefined();
    expect(patchArg[`inbox/f1.json`]).toBeNull();
    const triaged = JSON.parse(patchArg[`triaged/f1.json`]!);
    expect(triaged.status).toBe('triaged');
  });

  it('skips semantic dedup when memory query fails', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-new' });
    const existing = makeTriagedFinding({
      id: 'f0',
      clusterId: 'c0',
      dedupKey: 'dk-old',
    });
    setupConfigMap([f1], [existing]);

    queryMemorySpy.mockRejectedValue(new Error('memory unavailable'));

    const project = makeProject({ embeddingEnabled: true });
    await ingestFindings(project, namespace);

    const patchArg = patchFindingsConfigMapSpy.mock.calls[0]![1] as Record<string, string | null>;
    expect(patchArg[`triaged/f1.json`]).toBeDefined();
  });

  it('does not deduplicate when semantic distance is too high', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-new' });
    const existing = makeTriagedFinding({
      id: 'f0',
      clusterId: 'c0',
      dedupKey: 'dk-old',
    });
    setupConfigMap([f1], [existing]);

    queryMemorySpy.mockResolvedValue([
      {
        id: 'mem1',
        content: 'different',
        distance: 0.5,
        metadata: { kind: 'finding', clusterId: 'c0' },
      },
    ]);

    const project = makeProject({ embeddingEnabled: true });
    await ingestFindings(project, namespace);

    const patchArg = patchFindingsConfigMapSpy.mock.calls[0]![1] as Record<string, string | null>;
    expect(patchArg[`triaged/f1.json`]).toBeDefined();
  });

  it('auto-creates a BUILD task for high-severity bug findings', async () => {
    const f1 = makeInboxFinding({
      id: 'f1',
      dedupKey: 'dk-1',
      severity: 'high',
      category: 'bug',
    });
    setupConfigMap([f1]);

    const project = makeProject({ agents: [{ name: 'builder' }, { name: 'planner' }] });
    await ingestFindings(project, namespace);

    expect(buildTaskSpy).toHaveBeenCalledTimes(1);
    expect(createTaskSpy).toHaveBeenCalledTimes(1);
    expect(patchTaskStatusSpy).toHaveBeenCalledTimes(1);
    expect(patchTaskSpy).toHaveBeenCalledTimes(1);
  });

  it('auto-creates a PLAN task for high-severity security findings', async () => {
    const f1 = makeInboxFinding({
      id: 'f1',
      dedupKey: 'dk-1',
      severity: 'critical',
      category: 'security',
    });
    setupConfigMap([f1]);

    const project = makeProject({ agents: [{ name: 'planner' }, { name: 'builder' }] });
    await ingestFindings(project, namespace);

    expect(buildTaskSpy).toHaveBeenCalledTimes(1);
    const buildCall = buildTaskSpy.mock.calls[0]![0];
    expect(buildCall.spec.type).toBe('PLAN');
  });

  it('does not auto-create task for medium/low severity', async () => {
    const f1 = makeInboxFinding({
      id: 'f1',
      dedupKey: 'dk-1',
      severity: 'medium',
      category: 'bug',
    });
    setupConfigMap([f1]);

    const project = makeProject({ agents: [{ name: 'builder' }] });
    await ingestFindings(project, namespace);

    expect(buildTaskSpy).not.toHaveBeenCalled();
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  it('does not auto-create task for high-severity debt findings', async () => {
    const f1 = makeInboxFinding({
      id: 'f1',
      dedupKey: 'dk-1',
      severity: 'high',
      category: 'debt',
    });
    setupConfigMap([f1]);

    const project = makeProject({ agents: [{ name: 'builder' }] });
    await ingestFindings(project, namespace);

    expect(buildTaskSpy).not.toHaveBeenCalled();
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  it('stores finding in memory when embedding is enabled', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-1' });
    setupConfigMap([f1]);

    const project = makeProject({ embeddingEnabled: true });
    await ingestFindings(project, namespace);

    expect(storeMemorySpy).toHaveBeenCalledTimes(1);
  });

  it('does not store in memory when embedding is disabled', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-1' });
    setupConfigMap([f1]);

    const project = makeProject({ embeddingEnabled: false });
    await ingestFindings(project, namespace);

    expect(storeMemorySpy).not.toHaveBeenCalled();
  });

  it('caps board findings at 100', async () => {
    const inbox: Finding[] = [];
    for (let i = 0; i < 5; i++) {
      inbox.push(
        makeInboxFinding({
          id: `f${i}`,
          dedupKey: `dk-${i}`,
          createdAt: `2026-06-15T00:00:0${i}.000Z`,
        }),
      );
    }
    setupConfigMap(inbox);

    const project = makeProject();
    await ingestFindings(project, namespace);

    expect(patchProjectStatusSpy).toHaveBeenCalledTimes(1);
  });

  it('sorts board findings by triagedAt descending (newest first)', async () => {
    const f1 = makeInboxFinding({
      id: 'f1',
      dedupKey: 'dk-1',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const f2 = makeInboxFinding({
      id: 'f2',
      dedupKey: 'dk-2',
      createdAt: '2026-06-15T01:00:00.000Z',
    });
    setupConfigMap([f1, f2]);

    const project = makeProject();
    await ingestFindings(project, namespace);

    const statusArg = patchProjectStatusSpy.mock.calls[0]![1] as { board: { findings: Finding[] } };
    expect(statusArg.board.findings).toHaveLength(2);
  });

  it('handles duplicate findings gracefully even when dedupKey match fails to find canonical', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-1' });
    setupConfigMap([f1]);

    const project = makeProject();
    await ingestFindings(project, namespace);

    expect(patchFindingsConfigMapSpy).toHaveBeenCalledTimes(1);
  });

  it('emits FindingTriaged event for new finding', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-1' });
    setupConfigMap([f1]);

    const project = makeProject();
    await ingestFindings(project, namespace);

    expect(emitEventSpy).toHaveBeenCalled();
    const triagedCalls = emitEventSpy.mock.calls.filter((c: any[]) => c[3] === 'FindingTriaged');
    expect(triagedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('emits FindingDuplicate event for duplicate finding', async () => {
    const f1 = makeInboxFinding({ id: 'f1', dedupKey: 'dk-same' });
    const existing = makeTriagedFinding({
      id: 'f0',
      clusterId: 'c0',
      dedupKey: 'dk-same',
      occurrences: 1,
    });
    setupConfigMap([f1], [existing]);

    const project = makeProject();
    await ingestFindings(project, namespace);

    const dupCalls = emitEventSpy.mock.calls.filter((c: any[]) => c[3] === 'FindingDuplicate');
    expect(dupCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('sets critical severity findings to high priority task', async () => {
    const f1 = makeInboxFinding({
      id: 'f1',
      dedupKey: 'dk-1',
      severity: 'critical',
      category: 'bug',
    });
    setupConfigMap([f1]);

    const project = makeProject({ agents: [{ name: 'builder' }] });
    await ingestFindings(project, namespace);

    expect(buildTaskSpy).toHaveBeenCalledTimes(1);
    expect(buildTaskSpy.mock.calls[0]![0].spec.priority).toBe('high');
  });
});

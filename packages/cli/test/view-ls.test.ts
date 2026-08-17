// view-ls.test.ts — E item: `beatctl ls -A/--all-namespaces` was accepted but
// silently ignored (both paths listed the default namespace). runLs now does a
// true cluster-wide listing via listClusterCustomObject and adds a NAMESPACE
// column; the namespaced path stays on listNamespacedCustomObject.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as kubeCli from '../src/kube.js';
import { runLs } from '../src/view.js';

function makeRun(name: string, namespace: string) {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: { name, namespace, creationTimestamp: new Date().toISOString() },
    spec: {},
    status: { phase: 'Running' },
  };
}

let listClusterCalls: unknown[];
let listNamespacedCalls: unknown[];
let custom: {
  listClusterCustomObject: ReturnType<typeof mock>;
  listNamespacedCustomObject: ReturnType<typeof mock>;
};
let logSpy: ReturnType<typeof spyOn>;
let loadKubeSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  listClusterCalls = [];
  listNamespacedCalls = [];
  custom = {
    listClusterCustomObject: mock((args: unknown) => {
      listClusterCalls.push(args);
      return Promise.resolve({ items: [makeRun('run-a', 'ns-1'), makeRun('run-b', 'ns-2')] });
    }),
    listNamespacedCustomObject: mock((args: unknown) => {
      listNamespacedCalls.push(args);
      return Promise.resolve({ items: [makeRun('run-a', 'ns-1')] });
    }),
  };
  loadKubeSpy = spyOn(kubeCli, 'loadKube').mockReturnValue({ custom } as never);
  logSpy = spyOn(console, 'log');
});

afterEach(() => {
  loadKubeSpy.mockRestore();
  logSpy.mockRestore();
});

describe('runLs', () => {
  it('-A lists cluster-wide via listClusterCustomObject and shows the namespace column', async () => {
    await runLs({ allNamespaces: true });

    expect(listClusterCalls).toHaveLength(1);
    expect(listClusterCalls[0]).toMatchObject({
      group: 'percussionist.dev',
      version: 'v1alpha1',
      plural: 'runs',
    });
    expect(listNamespacedCalls).toHaveLength(0);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('NAMESPACE');
    expect(output).toContain('run-a');
    expect(output).toContain('run-b');
  });

  it('without -A lists in the requested namespace (no cluster-wide call)', async () => {
    await runLs({ namespace: 'team-ns' });

    expect(listNamespacedCalls).toHaveLength(1);
    expect(listNamespacedCalls[0]).toMatchObject({
      group: 'percussionist.dev',
      namespace: 'team-ns',
      plural: 'runs',
    });
    expect(listClusterCalls).toHaveLength(0);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).not.toContain('NAMESPACE');
    expect(output).toContain('run-a');
  });

  it('prints an all-namespaces empty message when nothing exists', async () => {
    custom.listClusterCustomObject.mockImplementation(() => Promise.resolve({ items: [] }));
    await runLs({ allNamespaces: true });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toBe('No Runs in any namespace.');
  });
});

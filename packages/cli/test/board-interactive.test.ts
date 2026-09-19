// board-interactive.test.ts — `beatctl board task interactive` arg handling and
// annotation payload.
//
// The command writes `percussionist.dev/action-interactive` rather than creating
// a Run: the manager's reconciler is the single Run-creation authority. These
// tests pin the flag → options mapping and the JSON payload the reconciler
// consumes, so the CLI never drifts from the shared contract.

import { describe, expect, it } from 'bun:test';
import { INTERACTIVE_RUN_ANNOTATION, type Task } from '@percussionist/api';
import { interactiveTaskMetadataPatch } from '../src/board.ts';
import { parseBoardTaskInteractiveArgs } from '../src/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: {
      name: 'proj-build-abc',
      namespace: 'percussionist',
      uid: 'task-uid',
      annotations: { 'pre-existing': 'keep' },
      resourceVersion: '42',
    },
    spec: {
      projectRef: 'proj',
      type: 'BUILD',
      title: 'task',
      agent: 'builder',
    },
    status: { phase: 'running' },
    ...overrides,
  } as Task;
}

describe('parseBoardTaskInteractiveArgs', () => {
  it('maps --task-name, --agent, --model, and --namespace', () => {
    const opts = parseBoardTaskInteractiveArgs([
      '--task-name',
      'proj-build-abc',
      '--agent',
      'builder',
      '--model',
      'openai/gpt-5',
      '--namespace',
      'custom',
    ]);
    expect(opts).toEqual({
      taskName: 'proj-build-abc',
      agent: 'builder',
      model: 'openai/gpt-5',
      namespace: 'custom',
    });
  });

  it('defaults the namespace and leaves overrides unset', () => {
    const opts = parseBoardTaskInteractiveArgs(['--task-name', 'proj-build-abc']);
    expect(opts.taskName).toBe('proj-build-abc');
    expect(opts.agent).toBeUndefined();
    expect(opts.model).toBeUndefined();
    expect(opts.namespace).toBe('percussionist');
  });

  it('leaves taskName unset when the required flag is missing (action guards it)', () => {
    const opts = parseBoardTaskInteractiveArgs([]);
    expect(opts.taskName).toBeUndefined();
  });
});

describe('interactiveTaskMetadataPatch', () => {
  it('writes the shared annotation as a JSON request payload', () => {
    const patch = interactiveTaskMetadataPatch(makeTask(), {
      id: 'deadbeef',
      agent: 'builder',
      model: 'openai/gpt-5',
    });
    const raw = patch.metadata.annotations?.[INTERACTIVE_RUN_ANNOTATION];
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? '')).toEqual({
      id: 'deadbeef',
      agent: 'builder',
      model: 'openai/gpt-5',
    });
  });

  it('preserves pre-existing annotations and the rest of the metadata', () => {
    const patch = interactiveTaskMetadataPatch(makeTask(), { id: 'a1b2c3d4' });
    expect(patch.metadata.name).toBe('proj-build-abc');
    expect(patch.metadata.resourceVersion).toBe('42');
    expect(patch.metadata.annotations?.['pre-existing']).toBe('keep');
    expect(patch.metadata.annotations?.[INTERACTIVE_RUN_ANNOTATION]).toBe(
      JSON.stringify({ id: 'a1b2c3d4' }),
    );
  });

  it('works when the task has no annotations yet', () => {
    const task = makeTask({ metadata: { name: 'bare', namespace: 'ns' } });
    const patch = interactiveTaskMetadataPatch(task, { id: 'a1b2c3d4' });
    expect(patch.metadata.annotations?.[INTERACTIVE_RUN_ANNOTATION]).toBe('{"id":"a1b2c3d4"}');
  });
});

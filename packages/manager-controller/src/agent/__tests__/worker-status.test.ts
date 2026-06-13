import { describe, expect, it } from 'bun:test';
import { clearWorkerRunRefs } from '../worker-status.js';

describe('clearWorkerRunRefs', () => {
  it('replaces run reference fields with null while preserving other fields', () => {
    const cleared = clearWorkerRunRefs();

    expect(cleared).toEqual({
      runName: null,
      reviewRunName: null,
      mergeRunName: null,
      buildTasksFacilitatorRun: null,
    });
  });
});

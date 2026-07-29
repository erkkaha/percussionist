import { describe, expect, it } from 'bun:test';
import {
  buildProjectRequest,
  createInitialState,
} from '../src/client/components/project-form/useProjectForm.js';

describe('project form request', () => {
  it('sends default flow values when editing so existing overrides can be reset', () => {
    const state = createInitialState({
      flow: { merge: { mode: 'disabled' } },
    });
    state.flowMergeMode = 'auto';

    const request = buildProjectRequest(state, true);

    expect(request.flow).toEqual({ merge: { mode: 'auto' } });
  });

  it('still omits default flow values when creating a project', () => {
    const request = buildProjectRequest(createInitialState(undefined), false);

    expect(request.flow).toBeUndefined();
  });
});

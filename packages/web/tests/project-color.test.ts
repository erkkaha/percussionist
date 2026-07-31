import { describe, expect, it } from 'bun:test';
import { PROJECT_COLOR_PRESETS, projectColor } from '../src/client/lib/project-color.js';

describe('projectColor', () => {
  it('is deterministic for the same name', () => {
    expect(projectColor('my-project')).toBe(projectColor('my-project'));
  });

  it('prefers an explicit specColor over the hashed fallback', () => {
    expect(projectColor('my-project', '#123456')).toBe('#123456');
  });

  it('ignores a falsy specColor and falls back to the hash', () => {
    expect(PROJECT_COLOR_PRESETS).toContain(projectColor('my-project', null));
    expect(PROJECT_COLOR_PRESETS).toContain(projectColor('my-project', ''));
    expect(PROJECT_COLOR_PRESETS).toContain(projectColor('my-project', undefined));
  });

  it('returns one of the preset colors for the hashed fallback', () => {
    expect(PROJECT_COLOR_PRESETS).toContain(projectColor('another-project'));
  });

  it('can produce different colors for different names', () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const colors = new Set(names.map((name) => projectColor(name)));
    expect(colors.size).toBeGreaterThan(1);
  });
});

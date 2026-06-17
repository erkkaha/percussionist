import { describe, expect, it } from 'bun:test';
import { parseRouteUsage } from '../src/client/hooks/useUsageTracker.js';

describe('usage tracker route categorization', () => {
  it('extracts project from /projects/:name/board', () => {
    expect(parseRouteUsage('/projects/acme/board')).toEqual({
      category: 'reviewing',
      project: 'acme',
    });
  });

  it('extracts and decodes project from /projects/:name/plans/:taskId', () => {
    expect(parseRouteUsage('/projects/acme%2Fml/plans/task-123')).toEqual({
      category: 'planning',
      project: 'acme/ml',
    });
  });
});

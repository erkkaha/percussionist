import { describe, expect, it } from 'bun:test';
import { FindingCategory, FindingSchema, FindingSeverity, FindingStatus } from '../index.js';

const baseFinding = {
  id: 'f1',
  title: 'Memory leak in worker',
  description: 'The worker process leaks memory on each retry cycle.',
  severity: 'high' as const,
  category: 'bug' as const,
  source: {
    project: 'test-project',
    task: 'task-1',
    run: 'run-abc',
    agent: 'builder',
  },
  dedupKey: 'abc123',
  createdAt: '2026-06-15T00:00:00.000Z',
};

describe('FindingSchema', () => {
  it('parses a valid complete finding', () => {
    const result = FindingSchema.safeParse(baseFinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('f1');
      expect(result.data.status).toBe('new');
      expect(result.data.occurrences).toBe(1);
    }
  });

  it('parses a finding with optional fields', () => {
    const result = FindingSchema.safeParse({
      ...baseFinding,
      filePath: 'src/worker.ts',
      snippet: 'const buf = Buffer.alloc(1024);',
      status: 'triaged',
      clusterId: 'c1',
      taskRef: 'test-project-build-abc',
      occurrences: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filePath).toBe('src/worker.ts');
      expect(result.data.snippet).toBe('const buf = Buffer.alloc(1024);');
      expect(result.data.status).toBe('triaged');
      expect(result.data.clusterId).toBe('c1');
      expect(result.data.taskRef).toBe('test-project-build-abc');
      expect(result.data.occurrences).toBe(3);
    }
  });

  it('defaults status to new and occurrences to 1', () => {
    const result = FindingSchema.safeParse({
      ...baseFinding,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('new');
      expect(result.data.occurrences).toBe(1);
    }
  });

  it('rejects missing required fields', () => {
    const cases = [
      { ...baseFinding, id: undefined },
      { ...baseFinding, title: undefined },
      { ...baseFinding, description: undefined },
      { ...baseFinding, severity: undefined },
      { ...baseFinding, category: undefined },
      { ...baseFinding, source: undefined },
      { ...baseFinding, dedupKey: undefined },
      { ...baseFinding, createdAt: undefined },
    ];
    for (const c of cases) {
      expect(FindingSchema.safeParse(c).success).toBe(false);
    }
  });

  it('rejects invalid severity values', () => {
    expect(FindingSchema.safeParse({ ...baseFinding, severity: 'urgent' }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...baseFinding, severity: '' }).success).toBe(false);
  });

  it('rejects invalid category values', () => {
    expect(FindingSchema.safeParse({ ...baseFinding, category: 'typo' }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...baseFinding, category: '' }).success).toBe(false);
  });

  it('accepts all valid severities', () => {
    for (const s of ['low', 'medium', 'high', 'critical']) {
      expect(FindingSchema.safeParse({ ...baseFinding, severity: s }).success).toBe(true);
    }
  });

  it('accepts all valid categories', () => {
    for (const c of ['bug', 'security', 'performance', 'debt', 'docs', 'other']) {
      expect(FindingSchema.safeParse({ ...baseFinding, category: c }).success).toBe(true);
    }
  });

  it('accepts all valid statuses', () => {
    for (const s of ['new', 'triaged', 'in-progress', 'resolved', 'duplicate', 'wontfix']) {
      expect(FindingSchema.safeParse({ ...baseFinding, status: s }).success).toBe(true);
    }
  });

  it('truncates title at 256 chars', () => {
    const result = FindingSchema.safeParse({
      ...baseFinding,
      title: 'x'.repeat(300),
    });
    expect(result.success).toBe(false);
  });

  it('rejects source without project', () => {
    const result = FindingSchema.safeParse({
      ...baseFinding,
      source: { task: 't1' },
    });
    expect(result.success).toBe(false);
  });

  it('allows optional source fields to be omitted', () => {
    const result = FindingSchema.safeParse({
      ...baseFinding,
      source: { project: 'test-project' },
    });
    expect(result.success).toBe(true);
  });
});

describe('FindingSeverity', () => {
  it('accepts valid enum values', () => {
    expect(FindingSeverity.enum.low).toBe('low');
    expect(FindingSeverity.enum.medium).toBe('medium');
    expect(FindingSeverity.enum.high).toBe('high');
    expect(FindingSeverity.enum.critical).toBe('critical');
  });
});

describe('FindingCategory', () => {
  it('accepts valid enum values', () => {
    expect(FindingCategory.enum.bug).toBe('bug');
    expect(FindingCategory.enum.security).toBe('security');
    expect(FindingCategory.enum.performance).toBe('performance');
    expect(FindingCategory.enum.debt).toBe('debt');
    expect(FindingCategory.enum.docs).toBe('docs');
    expect(FindingCategory.enum.other).toBe('other');
  });
});

describe('FindingStatus', () => {
  it('accepts valid enum values', () => {
    for (const s of ['new', 'triaged', 'in-progress', 'resolved', 'duplicate', 'wontfix']) {
      expect(FindingStatus.safeParse(s).success).toBe(true);
    }
  });

  it('rejects invalid status', () => {
    expect(FindingStatus.safeParse('unknown').success).toBe(false);
  });
});

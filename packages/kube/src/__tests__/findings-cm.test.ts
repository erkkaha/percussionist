import { describe, expect, it } from 'bun:test';
import type { Finding } from '@percussionist/api';
import { parseInboxFindings, parseTriagedFindings } from '../index.js';

const makeFinding = (overrides: Partial<Finding> & { id: string }): Finding => ({
  id: overrides.id,
  title: overrides.title ?? 'Test finding',
  description: overrides.description ?? 'Something is wrong',
  severity: overrides.severity ?? 'high',
  category: overrides.category ?? 'bug',
  source: overrides.source ?? {
    project: 'test-project',
    task: 'task-1',
    run: 'run-1',
    agent: 'builder',
  },
  dedupKey: overrides.dedupKey ?? 'dk-1',
  createdAt: overrides.createdAt ?? '2026-06-15T00:00:00.000Z',
  ...(overrides.filePath ? { filePath: overrides.filePath } : {}),
  ...(overrides.snippet ? { snippet: overrides.snippet } : {}),
  ...(overrides.clusterId ? { clusterId: overrides.clusterId } : {}),
  ...(overrides.occurrences ? { occurrences: overrides.occurrences } : {}),
  ...(overrides.triagedAt ? { triagedAt: overrides.triagedAt } : {}),
  ...(overrides.taskRef ? { taskRef: overrides.taskRef } : {}),
  ...(overrides.status ? { status: overrides.status } : {}),
  ...(overrides.duplicateOf ? { duplicateOf: overrides.duplicateOf } : {}),
});

describe('parseInboxFindings', () => {
  it('returns empty array for empty data', () => {
    expect(parseInboxFindings({})).toEqual([]);
  });

  it('returns empty array for data with no inbox keys', () => {
    expect(parseInboxFindings({ 'triaged/c1.json': '{}' })).toEqual([]);
  });

  it('parses a single inbox finding', () => {
    const finding = makeFinding({ id: 'f1' });
    const data = { 'inbox/f1.json': JSON.stringify(finding) };
    const result = parseInboxFindings(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('f1');
  });

  it('parses multiple inbox findings sorted by createdAt ascending', () => {
    const f1 = makeFinding({ id: 'f1', createdAt: '2026-06-15T10:00:00.000Z' });
    const f2 = makeFinding({ id: 'f2', createdAt: '2026-06-15T09:00:00.000Z' });
    const f3 = makeFinding({ id: 'f3', createdAt: '2026-06-15T11:00:00.000Z' });
    const data = {
      'inbox/f1.json': JSON.stringify(f1),
      'inbox/f2.json': JSON.stringify(f2),
      'inbox/f3.json': JSON.stringify(f3),
    };
    const result = parseInboxFindings(data);
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('f2');
    expect(result[1]!.id).toBe('f1');
    expect(result[2]!.id).toBe('f3');
  });

  it('skips malformed JSON entries', () => {
    const valid = makeFinding({ id: 'f1' });
    const data = {
      'inbox/f1.json': JSON.stringify(valid),
      'inbox/bad.json': 'not json',
      'inbox/bad2.json': '{invalid}',
    };
    const result = parseInboxFindings(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('f1');
  });

  it('ignores non-inbox keys', () => {
    const finding = makeFinding({ id: 'f1' });
    const data = {
      'inbox/f1.json': JSON.stringify(finding),
      'other/f1.json': JSON.stringify(finding),
      'triaged/f1.json': JSON.stringify(finding),
    };
    const result = parseInboxFindings(data);
    expect(result).toHaveLength(1);
  });

  it('ignores inbox keys without .json suffix', () => {
    const finding = makeFinding({ id: 'f1' });
    const data = {
      'inbox/f1.yaml': JSON.stringify(finding),
      'inbox/f1.txt': JSON.stringify(finding),
    };
    const result = parseInboxFindings(data);
    expect(result).toHaveLength(0);
  });
});

describe('parseTriagedFindings', () => {
  it('returns empty map for empty data', () => {
    const result = parseTriagedFindings({});
    expect(result.size).toBe(0);
  });

  it('returns empty map for data with no triaged keys', () => {
    const result = parseTriagedFindings({ 'inbox/f1.json': '{}' });
    expect(result.size).toBe(0);
  });

  it('parses a single triaged finding keyed by clusterId', () => {
    const finding = makeFinding({ id: 'f1', clusterId: 'c1' });
    const data = { 'triaged/c1.json': JSON.stringify(finding) };
    const result = parseTriagedFindings(data);
    expect(result.size).toBe(1);
    expect(result.get('c1')!.id).toBe('f1');
    expect(result.get('c1')!.clusterId).toBe('c1');
  });

  it('parses multiple triaged findings', () => {
    const f1 = makeFinding({ id: 'f1', clusterId: 'c1' });
    const f2 = makeFinding({ id: 'f2', clusterId: 'c2' });
    const data = {
      'triaged/c1.json': JSON.stringify(f1),
      'triaged/c2.json': JSON.stringify(f2),
    };
    const result = parseTriagedFindings(data);
    expect(result.size).toBe(2);
    expect(result.get('c1')!.id).toBe('f1');
    expect(result.get('c2')!.id).toBe('f2');
  });

  it('skips triaged findings without clusterId', () => {
    const finding = makeFinding({ id: 'f1' });
    const data = { 'triaged/f1.json': JSON.stringify(finding) };
    const result = parseTriagedFindings(data);
    expect(result.size).toBe(0);
  });

  it('skips malformed JSON entries', () => {
    const valid = makeFinding({ id: 'f1', clusterId: 'c1' });
    const data = {
      'triaged/c1.json': JSON.stringify(valid),
      'triaged/bad.json': 'not json',
    };
    const result = parseTriagedFindings(data);
    expect(result.size).toBe(1);
  });

  it('ignores non-triaged keys', () => {
    const finding = makeFinding({ id: 'f1', clusterId: 'c1' });
    const data = {
      'triaged/c1.json': JSON.stringify(finding),
      'inbox/f1.json': JSON.stringify(finding),
    };
    const result = parseTriagedFindings(data);
    expect(result.size).toBe(1);
  });

  it('ignores triaged keys without .json suffix', () => {
    const finding = makeFinding({ id: 'f1', clusterId: 'c1' });
    const data = {
      'triaged/c1.yaml': JSON.stringify(finding),
    };
    const result = parseTriagedFindings(data);
    expect(result.size).toBe(0);
  });
});

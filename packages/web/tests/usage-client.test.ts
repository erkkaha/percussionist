import { describe, expect, it } from 'bun:test';
import { parseRouteUsage } from '../src/client/hooks/useUsageTracker.js';
import { readTodayUsage } from '../src/client/lib/usage-settings.js';

const memoryStorage = new Map<string, string>();

const fakeStorage: Storage = {
  get length() {
    return memoryStorage.size;
  },
  clear() {
    memoryStorage.clear();
  },
  getItem(key: string) {
    return memoryStorage.get(key) ?? null;
  },
  key(index: number) {
    return Array.from(memoryStorage.keys())[index] ?? null;
  },
  removeItem(key: string) {
    memoryStorage.delete(key);
  },
  setItem(key: string, value: string) {
    memoryStorage.set(key, value);
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: fakeStorage,
});

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

describe('usage settings localStorage compatibility parsing', () => {
  it('reads legacy shape without projects map and preserves counters', () => {
    memoryStorage.clear();
    const key = 'percussionist-usage-2099-01-01';
    memoryStorage.set(
      key,
      JSON.stringify({
        reviewing: 120,
        planning: 45,
        other: 30,
      }),
    );

    const realDate = Date;
    const fixedNow = new Date('2099-01-01T12:00:00.000Z');

    // Keep timezone-stable date extraction in getTodayKey().
    globalThis.Date = class extends realDate {
      constructor(value?: string | number | Date) {
        super(value ?? fixedNow);
      }
      static override now() {
        return fixedNow.getTime();
      }
    } as typeof Date;

    try {
      expect(readTodayUsage()).toEqual({
        reviewing: 120,
        planning: 45,
        other: 30,
        projects: {},
      });
    } finally {
      globalThis.Date = realDate;
    }
  });
});

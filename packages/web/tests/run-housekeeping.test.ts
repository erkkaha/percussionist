// run-housekeeping.test.ts — the background housekeeping wrapper must swallow
// every failure so pruneExpiredRunKeys / runRetentionCleanup can never reject
// into the process-level unhandledRejection handler (which calls
// process.exit(1) and kills every open SSE stream and attach terminal).
//
// Two layers, per the plan:
//   1. runHousekeeping (lib/run-housekeeping.ts) — unit-tested directly with
//      throwing / rejecting / slow fns.
//   2. pruneExpiredRunKeys (lib/agent-keys.ts) — exercised against a real temp
//      DB to prove it resolves (does not reject) on its happy path. The wrapper
//      is what guarantees a forced busy/error cannot propagate.

import { afterAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Test DB isolation — set before importing modules that read DATA_DIR lazily.

const TEST_DATA_DIR = join('/tmp', `percussionist-housekeeping-${Date.now()}`);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret-for-housekeeping';
process.env.WEB_BASE_URL = 'http://localhost:8080';
// Auth must be enforced so agent-keys takes its real path (same as
// agent-keys.test.ts).
delete process.env.AUTH_DISABLED;

mkdirSync(TEST_DATA_DIR, { recursive: true });

const { runHousekeeping } = await import('../src/server/lib/run-housekeeping.js');
const { pruneExpiredRunKeys, SERVICE_USER_ID } = await import('../src/server/lib/agent-keys.js');
const { closeDb, getDb, apikey } = await import('../src/server/db.js');
const { resetAuth } = await import('../src/server/lib/better-auth.js');

afterAll(() => {
  closeDb();
  resetAuth();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

// ===========================================================================
// runHousekeeping — unit tests
// ===========================================================================

describe('runHousekeeping', () => {
  it('catches and logs a throwing fn; run() resolves instead of rejecting', async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      const runner = runHousekeeping('test-throw', () => {
        throw new Error('boom');
      });
      await expect(runner.run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      const args = warn.mock.calls[0] as [string, string];
      expect(args[0]).toContain('test-throw failed');
      expect(args[1]).toContain('boom');
    } finally {
      console.warn = original;
    }
  });

  it('catches a rejected async fn and still resolves (forced error does not propagate)', async () => {
    const runner = runHousekeeping('test-reject', async () => {
      throw new Error('async boom');
    });
    await expect(runner.run()).resolves.toBeUndefined();
  });

  it('resolves without logging when the fn succeeds', async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      const runner = runHousekeeping('test-ok', () => 42);
      await expect(runner.run()).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      console.warn = original;
    }
  });

  it('skips an overlapping tick (re-entrancy guard) and runs again after', async () => {
    let release!: () => void;
    let calls = 0;
    const runner = runHousekeeping('test-slow', async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const first = runner.run();
    const overlap = runner.run(); // in-flight → skipped
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);

    release();
    await Promise.all([first, overlap]);
    expect(calls).toBe(1);

    // Once the previous tick has finished, the next run executes again.
    const third = runner.run();
    expect(calls).toBe(2);
    release(); // let the third tick finish
    await third;
  });
});

// ===========================================================================
// pruneExpiredRunKeys — real temp DB
// ===========================================================================

describe('pruneExpiredRunKeys against a live temp DB', () => {
  it('resolves (does not reject) and deletes only expired run keys', async () => {
    const db = getDb();

    const expiredId = `run-key-expired-${Date.now()}`;
    const keptId = `run-key-kept-${Date.now()}`;
    const nonRunId = `component-kept-${Date.now()}`;

    db.insert(apikey)
      .values([
        {
          id: expiredId,
          name: 'run:expired',
          referenceId: SERVICE_USER_ID,
          key: 'hash-expired',
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() - 60_000), // already past
        },
        {
          id: keptId,
          name: 'run:still-valid',
          referenceId: SERVICE_USER_ID,
          key: 'hash-valid',
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000), // still in the future
        },
        {
          id: nonRunId,
          name: 'component:operator',
          referenceId: SERVICE_USER_ID,
          key: 'hash-component',
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() - 60_000), // expired but not a run key
        },
      ])
      .run();

    // Must resolve — a rejection here would previously have hit the
    // unhandledRejection handler and called process.exit(1).
    await expect(pruneExpiredRunKeys()).resolves.toBe(1);

    const remaining = db.select({ id: apikey.id }).from(apikey).all();
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(expiredId);
    expect(ids).toContain(keptId);
    expect(ids).toContain(nonRunId);
  });

  it('resolves with 0 when there is nothing to prune', async () => {
    await expect(pruneExpiredRunKeys()).resolves.toBe(0);
  });
});

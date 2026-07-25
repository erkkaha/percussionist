// github-profile-mapping.test.ts — the GitHub profile → user mapping.
//
// Both behaviours here failed silently in production and are easy to break again:
//
//   * The sign-in allowlist depends on `githubLogin` surviving the provider
//     profile mapping. Declaring that additional field with `input: false`
//     makes better-auth drop it (see parseAdditionalUserInputFromProviderProfile
//     in better-auth/dist/db/schema.mjs), which silently turned every sign-in
//     into "account 'unknown' is not permitted".
//   * A GitHub account with a private email and an App without the "Email
//     addresses" permission yields no email at all, which the user table
//     rejects. We synthesize a noreply address instead.
//
// The mapping is exercised through the configured auth instance rather than a
// copy of the logic, so a config regression fails the test.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DATA_DIR = join('/tmp', `percussionist-gh-map-${Date.now()}`);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret-for-profile-mapping';
process.env.WEB_BASE_URL = 'http://localhost:8080';
process.env.GITHUB_CLIENT_ID = 'test-client-id';
process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
delete process.env.AUTH_DISABLED;

mkdirSync(TEST_DATA_DIR, { recursive: true });

const { getAuth, resetAuth } = await import('../src/server/lib/better-auth.js');

/** Reach the configured github provider's mapProfileToUser. */
function mapProfile(profile: Record<string, unknown>) {
  const provider = getAuth().options.socialProviders?.github as
    | { mapProfileToUser?: (p: Record<string, unknown>) => Record<string, unknown> }
    | undefined;
  if (!provider?.mapProfileToUser) throw new Error('github mapProfileToUser is not configured');
  return provider.mapProfileToUser(profile);
}

beforeAll(() => {
  process.env.GITHUB_ALLOWED_LOGINS = 'erkkaha, SomeoneElse';
  resetAuth();
});

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('githubLogin is persisted', () => {
  it('is carried through the profile mapping', () => {
    expect(mapProfile({ login: 'erkkaha', email: 'e@example.com' }).githubLogin).toBe('erkkaha');
  });

  it('is declared with input: true, or better-auth would discard it', () => {
    const fields = getAuth().options.user?.additionalFields as
      | Record<string, { input?: boolean }>
      | undefined;
    // input: false makes parseAdditionalUserInputFromProviderProfile skip the
    // field, which is what broke the allowlist in production.
    expect(fields?.githubLogin?.input).toBe(true);
  });
});

describe('email synthesis', () => {
  it('leaves a real email untouched', () => {
    const mapped = mapProfile({ login: 'erkkaha', email: 'real@example.com' });
    expect(mapped.email).toBeUndefined();
  });

  it('synthesizes a noreply address when GitHub returns none', () => {
    const mapped = mapProfile({ login: 'erkkaha', email: null });
    expect(mapped.email).toBe('erkkaha@users.noreply.github.com');
  });

  it('synthesizes for an empty-string email too', () => {
    expect(mapProfile({ login: 'erkkaha', email: '' }).email).toBe(
      'erkkaha@users.noreply.github.com',
    );
  });
});

describe('sign-in allowlist', () => {
  it('permits an allowlisted login', () => {
    expect(() => mapProfile({ login: 'erkkaha', email: 'e@example.com' })).not.toThrow();
  });

  it('is case-insensitive and tolerates whitespace in the env var', () => {
    expect(() => mapProfile({ login: 'ERKKAHA', email: 'e@example.com' })).not.toThrow();
    expect(() => mapProfile({ login: 'someoneelse', email: 'e@example.com' })).not.toThrow();
  });

  it('rejects a login that is not allowlisted', () => {
    expect(() => mapProfile({ login: 'randomstranger', email: 'e@example.com' })).toThrow(
      /not permitted to sign in/,
    );
  });

  it('rejects everyone when the allowlist is empty — never everyone in', () => {
    process.env.GITHUB_ALLOWED_LOGINS = '';
    resetAuth();
    try {
      expect(() => mapProfile({ login: 'erkkaha', email: 'e@example.com' })).toThrow(
        /Sign-in is closed/,
      );
    } finally {
      process.env.GITHUB_ALLOWED_LOGINS = 'erkkaha, SomeoneElse';
      resetAuth();
    }
  });

  it('rejects a missing login', () => {
    expect(() => mapProfile({ email: 'e@example.com' })).toThrow(/not permitted to sign in/);
  });
});

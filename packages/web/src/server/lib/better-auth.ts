// lib/better-auth.ts — the better-auth instance backing web authentication.
//
// Two kinds of caller are authenticated here, and they are deliberately kept
// apart:
//
//   1. The human operator — signs in with GitHub, gets an httpOnly session
//      cookie. A session is implicitly admin: it may reach every route.
//   2. Agents (dispatcher run pods, manager-controller) — hold an API key
//      scoped to a small set of permissions. A key is ONLY accepted on routes
//      explicitly marked with `scoped()` in ../auth.ts. It can never satisfy
//      `auth()` or `adminAuth()`, so a key scraped out of a run pod's env
//      cannot read settings or trigger an upgrade.
//
// Note on API keys: we do NOT enable the plugin's `enableSessionForAPIKeys`
// (better-auth documents it as unsuitable for production, as it mints a mock
// session for the key holder). `scoped()` calls `auth.api.verifyApiKey`
// directly instead, which also hands us the key's permissions for auditing.
//
// Environment:
//   SESSION_SECRET        — signing secret for sessions (required in prod)
//   WEB_BASE_URL          — public base URL; must match the GitHub callback
//   GITHUB_CLIENT_ID      — GitHub App client id
//   GITHUB_CLIENT_SECRET  — GitHub App client secret
//   GITHUB_ALLOWED_LOGINS — comma-separated GitHub logins permitted to sign in
//   AUTH_DISABLED=1       — bypasses auth entirely (dev/e2e); this module is
//                           then never initialised.

import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer, deviceAuthorization } from 'better-auth/plugins';
import { getDb } from '../db.js';
import * as schema from '../schema.js';

// ---------------------------------------------------------------------------
// Permission model
//
// Every scope an agent key can hold. `scoped()` names one resource+action
// pair per route; keys are minted with exactly the pairs their caller needs.
// There is intentionally no wildcard: broad access is a session, not a key.

export const PERMISSIONS = {
  /** POST/PATCH /api/stats/session — dispatcher + manager session stats. */
  stats: ['write'],
  /** POST /api/projects/:project/board/task-events — reconciler audit log. */
  events: ['write'],
  /** GET /api/board/:project/events — manager's list_task_events tool. */
  board: ['read'],
  /** POST/DELETE /api/internal/run-keys — operator minting per-run keys. */
  runkeys: ['mint'],
} as const;

export type PermissionResource = keyof typeof PERMISSIONS;

/** Scopes granted to a per-run key handed to a dispatcher pod. */
export const RUN_KEY_PERMISSIONS: Record<string, string[]> = { stats: ['write'] };

/** Scopes granted to the standing manager-controller key. */
export const MANAGER_KEY_PERMISSIONS: Record<string, string[]> = {
  stats: ['write'],
  events: ['write'],
  board: ['read'],
};

/** Scopes granted to the operator's bootstrap key. */
export const OPERATOR_KEY_PERMISSIONS: Record<string, string[]> = { runkeys: ['mint'] };

// ---------------------------------------------------------------------------
// Instance singleton
//
// Lazy, because getDb() applies pending migrations on first call and must not
// run at import time (app.ts is imported by tests that never touch the DB).

let _auth: ReturnType<typeof buildAuth> | null = null;

function allowedGithubLogins(): string[] {
  return (process.env.GITHUB_ALLOWED_LOGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Throw unless this GitHub login may sign in.
 *
 * Without this the GitHub callback accepts any GitHub account on the internet,
 * so an empty allowlist has to mean "nobody", never "everybody".
 */
function assertGithubLoginAllowed(login: string | undefined): void {
  const allowed = allowedGithubLogins();
  if (allowed.length === 0) {
    throw new APIError('FORBIDDEN', {
      message:
        'Sign-in is closed: no GitHub logins are allowlisted. Set one with `beatctl auth github allow <login>`.',
    });
  }
  const normalized = (login ?? '').trim().toLowerCase();
  if (!normalized || !allowed.includes(normalized)) {
    throw new APIError('FORBIDDEN', {
      message: `GitHub account '${login ?? 'unknown'}' is not permitted to sign in.`,
    });
  }
}

function buildAuth() {
  const baseURL = process.env.WEB_BASE_URL ?? 'http://localhost:8080';

  return betterAuth({
    baseURL,
    secret: process.env.SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), { provider: 'sqlite', schema }),

    // Accept the canonical origin plus loopback, so a `beatctl web` port-forward
    // (which lands on a random localhost port) can still call the API and run
    // the device-approval flow.
    //
    // This does NOT make GitHub sign-in work from a port-forward: the OAuth
    // redirect_uri is derived from baseURL, and a GitHub App requires the
    // callback to match a registered URL exactly (no loopback port exception —
    // that is a classic-OAuth-App behaviour). Sign in via the canonical origin.
    trustedOrigins: [baseURL, 'http://localhost:*', 'http://127.0.0.1:*'],

    // No SMTP in this deployment — GitHub is the only way in.
    emailAndPassword: { enabled: false },

    onAPIError: {
      // Send failures back to our own login page instead of better-auth's
      // standalone error page. LoginPage already reads ?error= and renders it,
      // so a failed sign-in leaves you somewhere you can retry rather than on a
      // dead end showing "Something went wrong / CODE: email_not_found".
      errorURL: '/login',

      // Auth failures are security-relevant and were previously only visible by
      // tailing the pod. Log them explicitly.
      onError: (error) => {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : JSON.stringify(error);
        console.error(`[auth] API error: ${message}`);
      },

      // Fallback styling for anything that still reaches the built-in page
      // (visit /api/auth/error to preview). Values mirror the dashboard theme
      // in src/client/index.css so it doesn't look like a different product.
      customizeDefaultErrorPage: {
        colors: {
          background: '#111317',
          cardBackground: '#111317',
          foreground: '#e2e2e8',
          mutedForeground: '#9a9aa2',
          primary: '#e8a852',
          primaryForeground: '#111317',
          border: '#514537',
          destructive: '#ffb4ab',
          titleColor: '#e2e2e8',
        },
        font: {
          defaultFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          monoFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
        disableBackgroundGrid: true,
        disableCornerDecorations: true,
      },
    },

    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID ?? '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
        // The allowlist is enforced here, on the profile GitHub just returned,
        // because this runs on EVERY sign-in — not only when the user row is
        // first created. Removing a login from the allowlist therefore blocks
        // their next sign-in, rather than only preventing initial sign-up.
        //
        // Also carries the login through to `githubLogin` for reference; the
        // default profile mapping keeps only name/email/image.
        mapProfileToUser: (profile) => {
          assertGithubLoginAllowed(profile.login);
          return {
            githubLogin: profile.login,
            // Synthesize an address when GitHub gives us none, which happens
            // when the account's email is private and the App lacks the
            // "Email addresses" account permission. The user table requires a
            // non-null unique email, and there is no SMTP in this deployment —
            // nothing ever sends to this address, it only has to exist. Using
            // GitHub's own reserved noreply domain keeps it unroutable.
            //
            // By this point better-auth has already tried /user/emails and
            // written any result back onto profile.email, so an empty value
            // here means there genuinely is nothing to use.
            ...(profile.email ? {} : { email: `${profile.login}@users.noreply.github.com` }),
          };
        },
      },
    },

    user: {
      additionalFields: {
        // `input: true` is required, not a looseness: better-auth drops any
        // additional field marked `input: false` when mapping a provider
        // profile (see parseAdditionalUserInputFromProviderProfile), so
        // `input: false` would silently discard the value mapped above.
        // Safe here because there is no client-driven sign-up to inject
        // through — emailAndPassword is disabled and GitHub is the only path.
        githubLogin: { type: 'string', required: false, input: true },
      },
    },

    databaseHooks: {
      user: {
        create: {
          // Backstop for the check in mapProfileToUser: refuse to create a user
          // row for a login that is not allowlisted, whatever path got here.
          before: async (user) => {
            assertGithubLoginAllowed(
              typeof user.githubLogin === 'string' ? user.githubLogin : undefined,
            );
          },
        },
      },
    },

    plugins: [
      apiKey({
        // Keys arrive as `Authorization: Bearer <key>` from agents, which is
        // what dispatcher/manager-controller already send. `scoped()` extracts
        // the value itself and calls verifyApiKey, so no header config is
        // needed here.
        defaultPrefix: 'pcn_',
        requireName: true,
        // Keys are named after their holder ("run:<runName>", "component:
        // operator"); the 32-char default is too short for Run names.
        maximumNameLength: 128,
        // Per-run keys carry {runName, runUid, project} so a key can be traced
        // back to the run that held it.
        enableMetadata: true,
        keyExpiration: {
          // minExpiresIn is measured in DAYS and defaults to 1, which would
          // reject the hour-scale TTLs used for per-run keys.
          minExpiresIn: 0,
          maxExpiresIn: 365,
        },
        // Disabled deliberately. The plugin default is 10 requests/day, which
        // would silently drop stats flushes (stats-reporter does not retry).
        // These keys are already narrowly scoped, so throughput is not the
        // control we rely on.
        rateLimit: { enabled: false },
      }),
      // RFC 8628 device grant, so `beatctl auth login` can obtain a session
      // without pasting a token. Codes are approved from /device in the UI.
      deviceAuthorization({
        expiresIn: '10m',
        interval: '3s',
      }),
      // The device grant hands the CLI a raw session token to send as
      // `Authorization: Bearer <token>`; this plugin is what makes the server
      // accept a session presented in a header rather than a cookie. Required
      // for `beatctl auth login` — the browser continues to use cookies.
      bearer(),
    ],
  });
}

export function getAuth(): ReturnType<typeof buildAuth> {
  _auth ??= buildAuth();
  return _auth;
}

/** Test seam — drops the cached instance so a fresh DATA_DIR is picked up. */
export function resetAuth(): void {
  _auth = null;
}

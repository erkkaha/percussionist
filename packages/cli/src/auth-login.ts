// auth-login.ts — `beatctl auth login|logout|whoami`.
//
// OAuth 2.0 device authorization grant (RFC 8628), the same shape `gh auth login`
// uses: the CLI asks for a code, you approve it in an already-signed-in browser,
// and the CLI receives a session. No token is ever pasted between the two.
//
//   1. POST /api/auth/device/code       → device_code + user_code
//   2. print the user code + verification URL, open a browser
//   3. poll POST /api/auth/device/token → access_token once approved
//   4. store the token in ~/.config/percussionist/session.json (0600)
//
// The approval page sits behind the dashboard's auth guard, so approving
// requires an existing GitHub session — the CLI inherits your identity rather
// than establishing one of its own.

import { spawn } from 'node:child_process';
import { DEFAULT_NAMESPACE } from './kube.js';
import { clearSession, readSession, webRequest, withWebApi, writeSession } from './web-client.js';

/** Client id the server sees; `validateClient` is not configured, so it is a label. */
const CLIENT_ID = 'beatctl';

/** RFC 8628 grant type. The token endpoint validates this literal. */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface DeviceTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface AuthLoginOpts {
  namespace?: string;
  /** Don't try to open a browser; just print the URL. */
  noBrowser?: boolean;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // No browser opener available — the printed URL is the fallback.
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the token endpoint until the code is approved, denied or expires.
 *
 * Uses raw fetch rather than webRequest because the pending state is reported as
 * a 400 with `error: "authorization_pending"`, which is expected control flow
 * rather than a failure.
 */
async function pollForToken(
  baseUrl: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
): Promise<string> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = intervalSeconds;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    const res = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: CLIENT_ID,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as DeviceTokenResponse;

    if (body.access_token) return body.access_token;

    switch (body.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        // The server is asking us to back off.
        interval += 5;
        break;
      case 'access_denied':
        throw new Error('Request denied in the browser.');
      case 'expired_token':
        throw new Error('The code expired before it was approved.');
      default:
        throw new Error(body.error_description ?? body.error ?? `HTTP ${res.status}`);
    }
  }

  throw new Error('Timed out waiting for approval.');
}

export async function runAuthLogin(opts: AuthLoginOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;

  await withWebApi(ns, async (baseUrl) => {
    let start: DeviceCodeResponse;
    try {
      const res = await fetch(`${baseUrl}/api/auth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error_description?: string };
        throw new Error(body.error_description ?? `HTTP ${res.status} ${res.statusText}`);
      }
      start = (await res.json()) as DeviceCodeResponse;
    } catch (e) {
      console.error('beatctl: could not start device login:', (e as Error).message);
      process.exit(1);
    }

    // verification_uri is relative to the server's own base URL, which for a
    // port-forward is not the URL the browser should visit. Prefer the
    // server-provided absolute URL when it looks absolute, else build one.
    const verifyUrl = start.verification_uri.startsWith('http')
      ? start.verification_uri
      : `${baseUrl}${start.verification_uri}`;
    const completeUrl =
      start.verification_uri_complete ??
      `${verifyUrl}?user_code=${encodeURIComponent(start.user_code)}`;

    console.log('');
    console.log(`  Your code:  ${start.user_code}`);
    console.log(`  Open:       ${completeUrl}`);
    console.log('');
    console.log('Waiting for approval… (Ctrl-C to abort)');

    if (!opts.noBrowser) openBrowser(completeUrl);

    let token: string;
    try {
      token = await pollForToken(
        baseUrl,
        start.device_code,
        start.interval ?? 3,
        start.expires_in ?? 600,
      );
    } catch (e) {
      console.error(`beatctl: login failed: ${(e as Error).message}`);
      process.exit(1);
    }

    writeSession({
      token,
      baseUrl: process.env.PERCUSSIONIST_WEB_URL,
      expiresAt: undefined,
    });
    console.log('beatctl: logged in.');
  });
}

export function runAuthLogout(): void {
  if (!readSession()) {
    console.log('beatctl: not logged in.');
    return;
  }
  clearSession();
  console.log('beatctl: logged out (local session discarded).');
}

export interface AuthWhoamiOpts {
  namespace?: string;
}

export async function runAuthWhoami(opts: AuthWhoamiOpts): Promise<void> {
  if (!readSession()) {
    console.error('beatctl: not logged in. Run `beatctl auth login`.');
    process.exit(1);
  }

  await withWebApi(opts.namespace, async (baseUrl) => {
    try {
      const body = await webRequest<{ user?: { name?: string; email?: string } } | null>(
        baseUrl,
        '/api/auth/get-session',
      );
      if (!body?.user) {
        console.error('beatctl: session is no longer valid. Run `beatctl auth login`.');
        process.exit(1);
      }
      console.log(body.user.email ?? body.user.name ?? 'signed in');
    } catch (e) {
      console.error('beatctl:', (e as Error).message);
      process.exit(1);
    }
  });
}

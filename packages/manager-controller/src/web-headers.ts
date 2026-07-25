// web-headers.ts — headers for calling the web API.
//
// The manager authenticates with its own standing API key (WEB_AUTH_TOKEN,
// sourced from the manager-api-key Secret), scoped to stats:write, events:write
// and board:read — not the shared dashboard credential it used to share with
// every other component.
//
// When no token is configured the header is omitted: that is the dev/e2e case
// where the web server runs with AUTH_DISABLED=1 and accepts anything.

const WEB_AUTH_TOKEN = process.env.WEB_AUTH_TOKEN ?? '';

export function webHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(WEB_AUTH_TOKEN ? { Authorization: `Bearer ${WEB_AUTH_TOKEN}` } : {}),
    ...extra,
  };
}

export function webJsonHeaders(): Record<string, string> {
  return webHeaders({ 'Content-Type': 'application/json' });
}

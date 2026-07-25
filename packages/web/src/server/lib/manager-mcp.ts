// lib/manager-mcp.ts — shared headers for calling the manager's MCP server.
//
// The manager requires a bearer token from non-loopback callers (see
// packages/manager-controller/src/agent/tools.ts). The token is the shared
// web-auth token, which the web server holds as AUTH_SECRET. When no token is
// configured (dev mode) the header is omitted and the manager allows the call.

export function managerMcpHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = process.env.AUTH_SECRET;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

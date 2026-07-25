// lib/manager-mcp.ts — shared headers for calling the manager's MCP server.
//
// The manager requires a bearer token from non-loopback callers (see
// packages/manager-controller/src/agent/tools.ts). That token is MCP_TOKEN,
// shared between this pod and the manager only — it used to be the dashboard's
// AUTH_SECRET, which was also injected into every run pod, so any agent that
// read its own environment could reach the manager's destructive tools.
//
// When no token is configured (dev mode) the header is omitted and the manager
// allows the call.

export function managerMcpHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = process.env.MCP_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

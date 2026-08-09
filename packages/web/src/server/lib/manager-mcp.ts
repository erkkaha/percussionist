// lib/manager-mcp.ts — shared client for calling the manager's MCP server.
//
// The manager requires a bearer token from non-loopback callers (see
// packages/manager-controller/src/agent/tools.ts). That token is MCP_TOKEN,
// shared between this pod and the manager only — it used to be the dashboard's
// AUTH_SECRET, which was also injected into every run pod, so any agent that
// read its own environment could reach the manager's destructive tools.
//
// When no token is configured (dev mode) the header is omitted and the manager
// allows the call.

import { NAMESPACE } from '../kube.js';

export const MANAGER_MCP_URL = `http://percussionist-manager.${NAMESPACE}.svc.cluster.local:4097/mcp`;

export function managerMcpHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = process.env.MCP_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export interface ManagerToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

/**
 * Thrown by callManagerTool when the manager MCP endpoint answers with a
 * non-2xx HTTP status. Callers that map HTTP failures to a distinct status
 * code (routes/plans.ts, routes/upgrade.ts) branch on this class; all other
 * failures are plain Error.
 */
export class ManagerMcpHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagerMcpHttpError';
  }
}

/**
 * Call a tool on the manager's MCP server (port 4097).
 *
 * Shared strict error handling: a non-2xx HTTP status throws ManagerMcpHttpError
 * with the status and the first 200 chars of the body; a body that is not
 * valid JSON throws; a JSON-RPC `error` field throws with its message. Returns
 * the JSON-RPC `result` (callers check `isError`).
 */
export async function callManagerTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<ManagerToolResult> {
  const res = await fetch(MANAGER_MCP_URL, {
    method: 'POST',
    headers: managerMcpHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new ManagerMcpHttpError(
      `Manager MCP service returned ${res.status}: ${bodyText.slice(0, 200)}`,
    );
  }

  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new Error('Failed to read response body from manager MCP service');
  }

  let mcpResponse: {
    result?: ManagerToolResult;
    error?: { message?: string };
  };
  try {
    mcpResponse = JSON.parse(body) as {
      result?: ManagerToolResult;
      error?: { message?: string };
    };
  } catch {
    throw new Error(`Manager MCP returned non-JSON response: ${body.slice(0, 500)}`);
  }

  if (mcpResponse.error) {
    throw new Error(mcpResponse.error.message ?? 'Manager MCP error');
  }

  return mcpResponse.result ?? {};
}

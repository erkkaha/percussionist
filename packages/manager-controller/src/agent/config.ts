// agent/config.ts — agent module constants and types.

export const OPENCODE_URL = process.env.AGENT_OPENCODE_URL ?? 'http://127.0.0.1:4096';
export const MCP_PORT = parseInt(process.env.AGENT_MCP_PORT ?? '4097', 10);
export const CHAT_PORT = parseInt(process.env.AGENT_CHAT_PORT ?? '4098', 10);
export const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS ?? '30000', 10);
export const FIRST_RESPONSE_TIMEOUT_MS = parseInt(process.env.FIRST_RESPONSE_TIMEOUT_MS ?? '0', 10);
export const AGENT_NAME = process.env.AGENT_NAME ?? 'manager-agent';
export const MANAGER_NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';

export const DECISION_AGENT_NAME = process.env.DECISION_AGENT_NAME ?? 'manager-decision';

// Stats reporter config (same namespace as manager, but separate service URL)
export const WEB_SERVICE_URL =
  process.env.WEB_SERVICE_URL ??
  `http://percussionist-web.${MANAGER_NAMESPACE}.svc.cluster.local:8080`;

// Outbound credential for calling the web API — the manager's own scoped API key
// (manager-api-key Secret). Prefer ../web-headers.ts over reading this directly.
export const WEB_AUTH_TOKEN = process.env.WEB_AUTH_TOKEN ?? '';

// Inbound credential for the MCP server: a token shared with the web pod only
// (manager-mcp-token Secret), deliberately distinct from WEB_AUTH_TOKEN so the
// manager's destructive tool surface is not gated by a credential that also
// exists in run pods.
export const MCP_TOKEN = process.env.MCP_TOKEN ?? '';

export interface AgentDecision {
  action: 'retry_same' | 'retry_alternative' | 'skip' | 'escalate';
  agent?: string;
  reason: string;
}

export interface FacilitationParseResult {
  parsed: {
    diagnosis: string;
    recommendedAction:
      | 'retry_same'
      | 'retry_alternative'
      | 'skip'
      | 'approve'
      | 'request_changes'
      | 'escalate';
    alternativeAgent?: string;
    suggestion?: string;
  } | null;
  corrected: boolean;
  rawOutput: string;
}

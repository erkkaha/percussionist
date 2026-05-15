// agent/config.ts — agent module constants and types.

export const OPENCODE_URL = process.env.AGENT_OPENCODE_URL ?? "http://127.0.0.1:4096";
export const MCP_PORT = parseInt(process.env.AGENT_MCP_PORT ?? "4097", 10);
export const CHAT_PORT = parseInt(process.env.AGENT_CHAT_PORT ?? "4098", 10);
export const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS ?? "30000", 10);
export const AGENT_NAME = process.env.AGENT_NAME ?? "manager-agent";
export const MANAGER_NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";

export const DECISION_AGENT_NAME = process.env.DECISION_AGENT_NAME ?? "manager-decision";

export interface AgentDecision {
  action: "retry_same" | "retry_alternative" | "skip" | "escalate";
  agent?: string;
  reason: string;
}

export interface FacilitationParseResult {
  parsed: {
    diagnosis: string;
    recommendedAction: "retry_same" | "retry_alternative" | "skip" | "approve" | "request_changes" | "escalate";
    alternativeAgent?: string;
    suggestion?: string;
  } | null;
  corrected: boolean;
  rawOutput: string;
}

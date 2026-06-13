// agent-resolver.ts — resolves ClusterAgent names to content at reconcile time.
//
// The operator fetches ClusterAgent CRs by name and returns their content so
// the pod-builder can mount them as a ConfigMap. This removes inline agent
// content from the run spec — agents are always referenced by name.

import type { AgentDef } from '@percussionist/api';
import { getClusterAgent } from '@percussionist/kube';

const log = (...args: unknown[]) => console.log(`[operator ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[operator ${new Date().toISOString()}]`, ...args);

export interface ResolveAgentsResult {
  agents: AgentDef[];
  /** Names that could not be resolved (ClusterAgent CR missing). */
  missing: string[];
}

/**
 * Resolves a list of ClusterAgent names (plus optional inline agents) to
 * {name, content} pairs ready for ConfigMap mounting.
 *
 * Unknown ClusterAgent names are recorded in `missing` rather than crashing
 * the reconcile — the caller decides whether to surface this as a warning.
 */
export async function resolveAgents(
  agentNames: string[],
  inlineAgents: AgentDef[] = [],
): Promise<ResolveAgentsResult> {
  const resolved: AgentDef[] = [];
  const missing: string[] = [];

  for (const name of agentNames) {
    try {
      const ca = await getClusterAgent(name);
      resolved.push({ name, content: ca.spec.content });
    } catch {
      err(`ClusterAgent "${name}" not found — skipping`);
      missing.push(name);
    }
  }

  // Inline agents (CLI escape hatch) appended last. Duplicates with the same
  // name as a ClusterAgent are intentional overrides.
  for (const inline of inlineAgents) {
    const idx = resolved.findIndex((a) => a.name === inline.name);
    if (idx >= 0) {
      log(`inline agent "${inline.name}" overrides ClusterAgent of same name`);
      resolved[idx] = inline;
    } else {
      resolved.push(inline);
    }
  }

  return { agents: resolved, missing };
}

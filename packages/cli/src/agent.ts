// `beatctl agent` — manage ClusterAgent resources (cluster-scoped agent catalog).

import { readFileSync } from "node:fs";
import YAML from "yaml";
import {
  API_GROUP_VERSION,
  KIND_CLUSTER_AGENT,
  type ClusterAgent,
} from "@percussionist/api";
import { DEFAULT_NAMESPACE, fatal, loadKube } from "./kube.js";

export interface AgentListOpts {
  allNamespaces?: boolean;
}

export interface AgentGetOpts {
  namespace?: string;
  output?: string;
}

export interface AgentCreateOpts {
  name?: string;
  namespace?: string;
  file?: string;
  dryRun?: boolean;
}

export interface AgentDeleteOpts {
  namespace?: string;
}

// List all ClusterAgents in the cluster.
export async function runAgentList(opts: AgentListOpts): Promise<void> {
  const { custom } = loadKube();
  try {
    const list = await custom.listClusterCustomObject({
      group: "percussionist.dev",
      version: "v1alpha1",
      plural: "clusteragents",
    });
    const items = (list as unknown as { items: ClusterAgent[] }).items;
    if (items.length === 0) {
      console.log("No ClusterAgents found.");
      return;
    }
    // Table output.
    console.log(
      ["NAME", "AGE"].map((h) => h.padEnd(24)).join(""),
    );
    for (const agent of items.sort((a, b) =>
      (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""),
    )) {
      const name = agent.metadata?.name ?? "?";
      const age = formatAge(agent.metadata?.creationTimestamp);
      console.log(
        [name.padEnd(24), age.padEnd(24)].join(""),
      );
    }
  } catch (e) {
    fatal("list failed", e);
  }
}

// Get details of a single ClusterAgent.
export async function runAgentGet(name: string, opts: AgentGetOpts): Promise<void> {
  const { custom } = loadKube();
  try {
    const agent = await custom.getClusterCustomObject({
      group: "percussionist.dev",
      version: "v1alpha1",
      plural: "clusteragents",
      name,
    });
    if (opts.output === "json") {
      console.log(JSON.stringify(agent, null, 2));
    } else if (opts.output === "yaml") {
      const doc = YAML.stringify({
        apiVersion: API_GROUP_VERSION,
        kind: KIND_CLUSTER_AGENT,
        ...agent,
      });
      console.log(doc);
    } else {
      // Default: show spec.content preview.
      const content = (agent as unknown as { spec?: { content?: string } }).spec?.content ?? "";
      const lines = content.split("\n").slice(0, 10).join("\n");
      console.log(`name: ${name}`);
      console.log(`content (${content.length} bytes):`);
      console.log(lines);
      if (content.split("\n").length > 10) {
        console.log(`... (${content.split("\n").length - 10} more lines)`);
      }
    }
  } catch (e) {
    fatal(`agent "${name}" not found`, e);
  }
}

// Create a new ClusterAgent from flags or a YAML file.
export async function runAgentCreate(opts: AgentCreateOpts): Promise<void> {
  const name = opts.name;
  if (!name && !opts.file) {
    console.error("beatctl: --name is required when --file is not supplied");
    process.exit(1);
  }

  let doc: unknown;
  try {
    doc = opts.file
      ? YAML.parse(readFileSync(opts.file, "utf8"))
      : { apiVersion: API_GROUP_VERSION, kind: KIND_CLUSTER_AGENT };
  } catch (e) {
    fatal("invalid agent spec", e);
  }

  if (opts.name && !opts.file) {
    doc = { ...(doc as object), metadata: { name: opts.name } };
  } else if (opts.file) {
    const d = doc as Record<string, unknown>;
    d.metadata = { ...(d.metadata ?? {}), name: opts.name ?? (d.metadata as Record<string, unknown>)?.name };
  }

  try {
    const { custom } = loadKube();
    await custom.createClusterCustomObject({
      group: "percussionist.dev",
      version: "v1alpha1",
      plural: "clusteragents",
      body: doc,
    });
    console.log(`${((doc as Record<string, unknown>)?.metadata as Record<string, unknown>)?.name ?? "?"} created`);
  } catch (e) {
    fatal("create failed", e);
  }
}

// Delete a ClusterAgent.
export async function runAgentDelete(name: string): Promise<void> {
  const { custom } = loadKube();
  try {
    await custom.deleteClusterCustomObject({
      group: "percussionist.dev",
      version: "v1alpha1",
      plural: "clusteragents",
      name,
    });
    console.log(`${name} deleted`);
  } catch (e) {
    fatal(`agent "${name}" not found or delete failed`, e);
  }
}

function formatAge(timestamp?: string): string {
  if (!timestamp) return "?";
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

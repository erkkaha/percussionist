import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAgents } from "../hooks/useAgents";
import { useAgentsEvents } from "../hooks/useAgentsEvents";
import { deleteAgent } from "../lib/api";
import { Button } from "./ui/button";

interface AgentListItem {
  name: string;
  content: string;
  model?: string;
}

function age(iso: string | undefined): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\u2026";
}

function AgentRow({ agent }: { agent: AgentListItem }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const del = useMutation({
    mutationFn: () => deleteAgent(agent.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  return (
    <tr className="hover:bg-surface-raised/60 transition-colors">
      <td className="px-4 py-3 font-medium text-text font-mono text-sm">
        {agent.name}
      </td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs">
        {agent.model ?? "-"}
      </td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs max-w-md truncate" title={agent.content}>
        {truncate(agent.content, 120)}
      </td>
      <td className="px-4 py-3 text-text-muted tabular-nums text-xs">
        {age(undefined)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/agents/${encodeURIComponent(agent.name)}/edit`)}
          >
            Edit
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (confirm(`Delete agent "${agent.name}"?`)) {
                del.mutate();
              }
            }}
            disabled={del.isPending}
          >
            {del.isPending ? "Deleting\u2026" : "Delete"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

export default function AgentsPage({ showHeader = true }: { showHeader?: boolean }) {
  const { connected: agentsSseConnected, eventTick } = useAgentsEvents();
  void eventTick;
  const { data: agents, error, isLoading, isFetching } = useAgents(
    agentsSseConnected ? false : 10_000,
  );

  if (error) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
        <h2 className="text-headline-md mb-1">Failed to load agents</h2>
        <p className="text-caption-xs">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showHeader && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-headline-lg">Agents</h1>
            <p className="text-caption-xs text-text-muted">
              Cluster-scoped reusable agent definitions.
              {isFetching && !isLoading && (
                <span className="ml-2 text-text-dim animate-pulse">refreshing</span>
              )}
            </p>
            <p className="text-caption-xs text-text-dim mt-0.5">
              Updates: {agentsSseConnected ? "live stream" : "polling fallback"}
            </p>
          </div>
          <Link to="/agents/new">
            <Button>+ New Agent</Button>
          </Link>
        </div>
      )}

      {isLoading ? (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="divide-y divide-border-muted">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-4 py-4 flex gap-6">
                <div className="h-4 w-32 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-32 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-48 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-16 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-16 rounded bg-surface-overlay animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ) : !agents || agents.length === 0 ? (
        <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
          No cluster agents yet.{" "}
          <Link to="/agents/new" className="underline hover:text-text transition-colors">
            Create one
          </Link>{" "}
          to define reusable agent prompts available across all runs.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden settings-table-scroll">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-text-muted text-left">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Content Preview</th>
                <th className="px-4 py-2.5 font-medium">Age</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-muted">
              {agents.map((a) => (
                <AgentRow key={a.name} agent={a} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

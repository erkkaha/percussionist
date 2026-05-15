import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProjects } from "../hooks/useProjects";
import { useProjectsEvents } from "../hooks/useProjectsEvents";
import { deleteProject } from "../lib/api";
import type { OpenCodeProject } from "../lib/types";

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

function ProjectRow({ project }: { project: OpenCodeProject }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const del = useMutation({
    mutationFn: () => deleteProject(project.metadata.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  return (
    <tr className="hover:bg-surface-raised/60 transition-colors">
      <td className="px-4 py-3 font-medium text-text font-mono text-sm">
        {project.metadata.name}
      </td>
      <td className="px-4 py-3 text-text-muted text-sm">
        {project.spec.displayName ?? "-"}
      </td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs truncate max-w-xs" title={project.spec.source?.git?.url}>
        {project.spec.source?.git?.url ?? "-"}
      </td>
      <td className="px-4 py-3 text-text-muted text-xs">
        {project.spec.source?.git?.ref ?? "-"}
      </td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs">
        {project.spec.model ?? "-"}
      </td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs">
        {project.spec.agent ?? "-"}
      </td>
      <td className="px-4 py-3 text-text-muted tabular-nums text-xs">
        {age(project.metadata.creationTimestamp)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(`/projects/${encodeURIComponent(project.metadata.name)}/edit`)}
            className="rounded border border-border-muted px-2 py-1 text-xs text-text-dim hover:border-accent/60 hover:text-text transition-colors"
          >
            Edit
          </button>
          <Link
            to={`/projects/${encodeURIComponent(project.metadata.name)}/board`}
            className="rounded border border-border-muted px-2 py-1 text-xs text-text-dim hover:border-accent/60 hover:text-text transition-colors"
          >
            Board
          </Link>
          <button
            onClick={() => {
              if (confirm(`Delete project "${project.metadata.name}"?`)) {
                del.mutate();
              }
            }}
            disabled={del.isPending}
            className="rounded border border-border-muted px-2 py-1 text-xs text-text-dim hover:border-phase-failed/50 hover:text-phase-failed transition-colors disabled:opacity-40"
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function ProjectsPage() {
  const { connected: projectsSseConnected, eventTick } = useProjectsEvents();
  void eventTick;
  const { data: projects, error, isLoading, isFetching } = useProjects(
    projectsSseConnected ? false : 10_000,
  );

  if (error) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
        <h2 className="text-lg font-semibold mb-1">Failed to load projects</h2>
        <p className="text-sm">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-text-muted">
            Reusable templates for run defaults (git, secrets, model).
            {isFetching && !isLoading && (
              <span className="ml-2 text-text-dim animate-pulse">refreshing</span>
            )}
          </p>
          <p className="text-xs text-text-dim mt-0.5">
            Updates: {projectsSseConnected ? "live stream" : "polling fallback"}
          </p>
        </div>
        <Link
          to="/projects/new"
          className="rounded-md bg-[#5c4a3a] hover:bg-[#6b5948] px-3 py-1.5 text-sm font-medium text-text transition-colors"
        >
          + New Project
        </Link>
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="divide-y divide-border-muted">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-4 py-4 flex gap-6">
                <div className="h-4 w-32 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-24 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-48 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-16 rounded bg-surface-overlay animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ) : !projects || projects.length === 0 ? (
        <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
          No projects yet.{" "}
          <Link to="/projects/new" className="underline hover:text-text transition-colors">
            Create one
          </Link>{" "}
          to save git URLs, secrets, and model defaults for reuse.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-text-muted text-left">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Display Name</th>
                <th className="px-4 py-2.5 font-medium">Git URL</th>
                <th className="px-4 py-2.5 font-medium">Ref</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">Age</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-muted">
              {projects.map((p) => (
                <ProjectRow key={p.metadata.uid ?? p.metadata.name} project={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

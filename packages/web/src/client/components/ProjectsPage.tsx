import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useProjects } from '../hooks/useProjects';
import { useProjectsEvents } from '../hooks/useProjectsEvents';
import { deleteProject } from '../lib/api';
import type { Project } from '../lib/types';
import { Button } from './ui/button';

function age(iso: string | undefined): string {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function ProjectRow({ project }: { project: Project }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const del = useMutation({
    mutationFn: () => deleteProject(project.metadata.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <tr className="hover:bg-surface-raised/60 transition-colors">
      <td className="px-4 py-3 font-medium text-text font-mono text-sm">{project.metadata.name}</td>
      <td className="px-4 py-3 text-text-muted text-sm">{project.spec.displayName ?? '-'}</td>
      <td
        className="px-4 py-3 text-text-muted font-mono text-xs truncate max-w-xs"
        title={project.spec.source?.git?.url}
      >
        {project.spec.source?.git?.url ?? '-'}
      </td>
      <td className="px-4 py-3 text-text-muted text-xs">{project.spec.source?.git?.ref ?? '-'}</td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs flex items-center gap-1">
        {(project as { authWarning?: string }).authWarning && (
          <span
            className="text-phase-failed"
            title={(project as { authWarning?: string }).authWarning}
          >
            ⚠
          </span>
        )}
        {project.spec.model ?? '-'}
      </td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs">{project.spec.agent ?? '-'}</td>
      <td className="px-4 py-3 text-text-muted tabular-nums text-xs">
        {age(project.metadata.creationTimestamp)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/projects/${encodeURIComponent(project.metadata.name)}/edit`)}
          >
            Edit
          </Button>
          <Link to={`/projects/${encodeURIComponent(project.metadata.name)}/board`}>
            <Button variant="outline" size="sm">
              Board
            </Button>
          </Link>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (confirm(`Delete project "${project.metadata.name}"?`)) {
                del.mutate();
              }
            }}
            disabled={del.isPending}
          >
            {del.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </td>
    </tr>
  );
}

export default function ProjectsPage({
  showHeader = true,
  showCreateAction = true,
}: {
  showHeader?: boolean;
  showCreateAction?: boolean;
}) {
  const { connected: projectsSseConnected, eventTick } = useProjectsEvents();
  void eventTick;
  const {
    data: projects,
    error,
    isLoading,
    isFetching,
  } = useProjects(projectsSseConnected ? false : 10_000);

  if (error) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
        <h2 className="text-headline-md mb-1">Failed to load projects</h2>
        <p className="text-caption-xs">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showHeader && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-headline-lg">Projects</h1>
            <p className="text-caption-xs text-text-muted">
              Reusable templates for run defaults (git, secrets, model).
              {isFetching && !isLoading && (
                <span className="ml-2 text-text-dim animate-pulse">refreshing</span>
              )}
            </p>
            <p className="text-caption-xs text-text-dim mt-0.5">
              Updates: {projectsSseConnected ? 'live stream' : 'polling fallback'}
            </p>
          </div>
          <Link to="/projects/new">
            <Button>+ New Project</Button>
          </Link>
        </div>
      )}

      {!showHeader && showCreateAction && projects && projects.length > 0 && (
        <div className="flex items-center justify-end">
          <Link to="/projects/new">
            <Button size="sm">+ New Project</Button>
          </Link>
        </div>
      )}

      {isLoading ? (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="divide-y divide-border-muted">
            {[0, 1, 2].map((k) => (
              <div key={k} className="px-4 py-4 flex gap-6">
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
          No projects yet.{' '}
          <Link to="/projects/new" className="underline hover:text-text transition-colors">
            Create one
          </Link>{' '}
          to save git URLs, secrets, and model defaults for reuse.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden settings-table-scroll">
          <table className="w-full min-w-[720px] text-sm">
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

import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchProject } from "../lib/api";
import CreateProjectForm from "./CreateProjectForm";

export default function EditProjectPage() {
  const { name } = useParams<{ name: string }>();

  const { data: project, error, isLoading } = useQuery({
    queryKey: ["projects", name],
    queryFn: () => fetchProject(name ?? ""),
    enabled: Boolean(name),
  });

  if (!name) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
        <h2 className="text-lg font-semibold mb-1">Invalid project</h2>
        <p className="text-sm">Missing project name in route.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
        >
          <span>&larr;</span> All projects
        </Link>
        <div className="rounded-lg border border-border p-6">
          <div className="h-5 w-40 rounded bg-surface-overlay animate-pulse" />
          <div className="mt-4 h-10 w-full rounded bg-surface-overlay animate-pulse" />
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
        <h2 className="text-lg font-semibold mb-1">Failed to load project</h2>
        <p className="text-sm">{error?.message ?? "Project not found"}</p>
      </div>
    );
  }

  return <CreateProjectForm mode="edit" initialProject={project} />;
}

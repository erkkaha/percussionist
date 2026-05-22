import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchPlan } from "../lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { ArrowLeft } from "lucide-react";

export default function PlanView() {
  const { name: projectName, taskId } = useParams<{ name: string; taskId: string }>();

  const { data, error, isLoading } = useQuery({
    queryKey: ["plan", projectName, taskId],
    queryFn: () => fetchPlan(projectName!, taskId!),
    enabled: !!projectName && !!taskId,
  });

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          to={`/projects/${encodeURIComponent(projectName!)}/board`}
          className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Board
        </Link>
        <Card className="border-phase-failed/30 bg-phase-failed/10">
          <CardHeader>
            <CardTitle className="text-phase-failed">Failed to load plan</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-phase-failed">{error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Link
          to={`/projects/${encodeURIComponent(projectName!)}/board`}
          className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Board
        </Link>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3 text-text-dim">
              <div className="animate-spin h-5 w-5 border-2 border-text-dim border-t-transparent rounded-full" />
              <span>Loading plan...</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back navigation */}
      <Link
        to={`/projects/${encodeURIComponent(projectName!)}/board`}
        className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Board
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text mb-1">Plan: {taskId}</h1>
          <p className="text-sm text-text-dim">Project: {projectName}</p>
        </div>
      </div>

      {/* Plan content */}
      <Card>
        <CardHeader className="border-b border-border-muted">
          <CardTitle className="text-sm font-medium text-text-muted">Plan Content</CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="prose prose-sm prose-slate dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {data.content}
            </ReactMarkdown>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

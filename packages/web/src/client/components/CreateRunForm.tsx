import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { submitRun } from "../lib/api";
import type { CreateRunRequest } from "../lib/types";

export default function CreateRunForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [task, setTask] = useState("");
  const [model, setModel] = useState("");
  const [agent, setAgent] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(3600);
  const [showGit, setShowGit] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");

  const mutation = useMutation({
    mutationFn: (req: CreateRunRequest) => submitRun(req),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/runs/${encodeURIComponent(run.metadata.name)}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const req: CreateRunRequest = { interactive, timeoutSeconds };
    if (task.trim()) req.task = task.trim();
    if (model.trim()) req.model = model.trim();
    if (agent.trim()) req.agent = agent.trim();
    if (showGit && gitUrl.trim()) {
      req.source = { git: { url: gitUrl.trim() } };
      if (gitRef.trim()) req.source.git!.ref = gitRef.trim();
    }
    mutation.mutate(req);
  }

  const canSubmit = interactive || task.trim().length > 0;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Back link */}
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
      >
        <span>&larr;</span> All runs
      </Link>

      <div>
        <h1 className="text-xl font-semibold">New Run</h1>
        <p className="text-sm text-text-muted mt-1">
          Submit a task for an OpenCode agent to work on.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Interactive toggle */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={interactive}
            onClick={() => setInteractive((v) => !v)}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors focus:outline-none ${
              interactive
                ? "border-phase-running bg-phase-running/20"
                : "border-border bg-surface-overlay"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-current transition-transform mt-[3px] ${
                interactive
                  ? "translate-x-[18px] text-phase-running"
                  : "translate-x-[3px] text-text-dim"
              }`}
            />
          </button>
          <span className="text-sm text-text">Interactive mode</span>
          <span className="text-xs text-text-dim">
            (no task — connect via <code className="font-mono">beatctl attach</code>)
          </span>
        </div>

        {/* Task */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">
            Task {!interactive && <span className="text-phase-failed">*</span>}
          </label>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={interactive}
            rows={5}
            placeholder={
              interactive
                ? "Not required in interactive mode"
                : "Describe what the agent should do..."
            }
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-zinc-500 focus:outline-none resize-y disabled:opacity-40 disabled:cursor-not-allowed"
          />
        </div>

        {/* Model + Agent row */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. anthropic/claude-sonnet-4-20250514"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-zinc-500 focus:outline-none font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Agent</label>
            <input
              type="text"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="e.g. build"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-zinc-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Timeout */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">
            Timeout (seconds)
          </label>
          <input
            type="number"
            min={1}
            value={timeoutSeconds}
            onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
            className="w-40 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-zinc-500 focus:outline-none tabular-nums"
          />
        </div>

        {/* Git source */}
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setShowGit((v) => !v)}
            className="flex items-center gap-2 text-sm text-text-muted hover:text-text transition-colors"
          >
            <span className={`transition-transform ${showGit ? "rotate-90" : ""}`}>▶</span>
            Git source (optional)
          </button>
          {showGit && (
            <div className="pl-4 border-l border-border-muted space-y-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-muted">Repository URL</label>
                <input
                  type="text"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-zinc-500 focus:outline-none font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-muted">
                  Ref <span className="text-text-dim font-normal">(branch / tag / SHA)</span>
                </label>
                <input
                  type="text"
                  value={gitRef}
                  onChange={(e) => setGitRef(e.target.value)}
                  placeholder="main"
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-zinc-500 focus:outline-none font-mono"
                />
              </div>
            </div>
          )}
        </div>

        {/* Error */}
        {mutation.error && (
          <div className="rounded-md border border-phase-failed/30 bg-phase-failed/10 px-4 py-3 text-sm text-phase-failed">
            {mutation.error.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={!canSubmit || mutation.isPending}
            className="rounded-md bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-text transition-colors"
          >
            {mutation.isPending ? "Submitting..." : "Submit Run"}
          </button>
          <Link
            to="/"
            className="text-sm text-text-muted hover:text-text transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

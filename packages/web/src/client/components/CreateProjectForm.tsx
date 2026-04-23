import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { submitProject } from "../lib/api";
import type { CreateProjectRequest } from "../lib/types";

export default function CreateProjectForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [model, setModel] = useState("");
  const [agent, setAgent] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitSshSecret, setGitSshSecret] = useState("");
  const [llmKeysSecret, setLlmKeysSecret] = useState("");
  const [authSecret, setAuthSecret] = useState("");

  const mutation = useMutation({
    mutationFn: (req: CreateProjectRequest) => submitProject(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/projects");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const req: CreateProjectRequest = {};
    if (name.trim()) req.name = name.trim();
    if (displayName.trim()) req.displayName = displayName.trim();
    if (model.trim()) req.model = model.trim();
    if (agent.trim()) req.agent = agent.trim();
    if (gitUrl.trim()) {
      req.source = {
        git: {
          url: gitUrl.trim(),
          ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
          ...(gitSshSecret.trim()
            ? { sshSecret: { name: gitSshSecret.trim() } }
            : {}),
        },
      };
    }
    if (llmKeysSecret.trim() || authSecret.trim()) {
      req.secrets = {
        ...(llmKeysSecret.trim() ? { llmKeysSecret: llmKeysSecret.trim() } : {}),
        ...(authSecret.trim()
          ? { opencodeAuthSecret: { name: authSecret.trim() } }
          : {}),
      };
    }
    mutation.mutate(req);
  }

  const inputClass =
    "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-zinc-500 focus:outline-none";
  const monoInputClass = inputClass + " font-mono";

  return (
    <div className="space-y-6 max-w-2xl">
      <Link
        to="/projects"
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
      >
        <span>&larr;</span> All projects
      </Link>

      <div>
        <h1 className="text-xl font-semibold">New Project</h1>
        <p className="text-sm text-text-muted mt-1">
          Save reusable defaults — git URL, secrets, model — under a short name.
          Pick this project when creating a run to pre-fill those fields.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name row */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">
              Name <span className="text-phase-failed">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-repo"
              className={monoInputClass}
            />
            <p className="text-xs text-text-dim">
              Kubernetes resource name (lowercase, hyphens)
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="My Repository"
              className={inputClass}
            />
          </div>
        </div>

        {/* Git section */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium text-text-muted">Git source</legend>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Repository URL</label>
            <input
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="git@github.com:org/repo.git"
              className={monoInputClass}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-muted">
                Ref <span className="text-text-dim font-normal">(branch / tag / SHA)</span>
              </label>
              <input
                type="text"
                value={gitRef}
                onChange={(e) => setGitRef(e.target.value)}
                placeholder="main"
                className={monoInputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-muted">SSH Secret</label>
              <input
                type="text"
                value={gitSshSecret}
                onChange={(e) => setGitSshSecret(e.target.value)}
                placeholder="git-ssh-key"
                className={monoInputClass}
              />
              <p className="text-xs text-text-dim">
                Secret name from{" "}
                <code className="font-mono">beatctl ssh-key create</code>
              </p>
            </div>
          </div>
        </fieldset>

        {/* Secrets section */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium text-text-muted">Secrets</legend>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-muted">LLM Keys Secret</label>
              <input
                type="text"
                value={llmKeysSecret}
                onChange={(e) => setLlmKeysSecret(e.target.value)}
                placeholder="llm-keys"
                className={monoInputClass}
              />
              <p className="text-xs text-text-dim">
                Secret with provider API keys (ANTHROPIC_API_KEY, etc.)
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-muted">Auth Secret</label>
              <input
                type="text"
                value={authSecret}
                onChange={(e) => setAuthSecret(e.target.value)}
                placeholder="opencode-auth"
                className={monoInputClass}
              />
              <p className="text-xs text-text-dim">
                Secret from{" "}
                <code className="font-mono">beatctl auth import</code>
              </p>
            </div>
          </div>
        </fieldset>

        {/* Model + Agent */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Default Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="anthropic/claude-sonnet-4-20250514"
              className={monoInputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Default Agent</label>
            <input
              type="text"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="build"
              className={inputClass}
            />
          </div>
        </div>

        {mutation.error && (
          <div className="rounded-md border border-phase-failed/30 bg-phase-failed/10 px-4 py-3 text-sm text-phase-failed">
            {mutation.error.message}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={!name.trim() || mutation.isPending}
            className="rounded-md bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-text transition-colors"
          >
            {mutation.isPending ? "Creating…" : "Create Project"}
          </button>
          <Link to="/projects" className="text-sm text-text-muted hover:text-text transition-colors">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

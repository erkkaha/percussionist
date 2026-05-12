import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { submitKanban } from "../lib/api";
import type { CreateKanbanRequest, AgentDef } from "../lib/types";

interface ClusterAgent {
  name: string;
  content: string;
}

async function fetchClusterAgents(): Promise<ClusterAgent[]> {
  const res = await fetch("/api/agents");
  if (!res.ok) return [];
  const data = await res.json();
  return (data.agents as ClusterAgent[]) ?? [];
}

function defaultTaskId(index: number): string {
  return `T-${String(index + 1).padStart(3, "0")}`;
}

export default function CreateKanbanForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [model, setModel] = useState("local/llama3.1-70b");
  const [timeoutSeconds, setTimeoutSeconds] = useState(14400);
  const [maxParallel, setMaxParallel] = useState(2);
  const [showGit, setShowGit] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitSshSecret, setGitSshSecret] = useState("");
  const [gitAuthorName, setGitAuthorName] = useState("Percussionist Agent");
  const [gitAuthorEmail, setGitAuthorEmail] = useState("agent@percussionist.local");
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [clusterAgents, setClusterAgents] = useState<ClusterAgent[]>([]);
  const [selectedClusterAgent, setSelectedClusterAgent] = useState("");

  // Load available cluster agents on mount.
  useEffect(() => {
    fetchClusterAgents().then(setClusterAgents).catch(() => {});
  }, []);

  function addTask() {
    if (agents.length >= 100) return;
    setAgents((prev) => [...prev, { name: "", content: "" }]);
  }

  function removeAgent(index: number) {
    setAgents((prev) => prev.filter((_, i) => i !== index));
  }

  function updateAgent(index: number, field: "name" | "content", value: string) {
    setAgents((prev) =>
      prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)),
    );
  }

  function handleClusterAgentSelect(name: string) {
    setSelectedClusterAgent(name);
    if (!name) {
      setAgents([]);
      return;
    }
    const found = clusterAgents.find((a) => a.name === name);
    if (found) {
      setAgents([{ name, content: found.content }]);
    }
  }

  // Build tasks from agent definitions.
  function buildTasks(): CreateKanbanRequest["tasks"] {
    return agents.map((a, i) => ({
      id: a.name || defaultTaskId(i),
      title: a.name || `Task ${i + 1}`,
      description: a.content?.split("---")[1]?.trim() ?? "Implement the feature described in this agent definition.",
      priority: "medium",
    }));
  }

  const mutation = useMutation({
    mutationFn: (req: CreateKanbanRequest) => submitKanban(req),
    onSuccess: (kanban) => {
      queryClient.invalidateQueries({ queryKey: ["kanbans"] });
      navigate(`/kanbans/${encodeURIComponent(kanban.metadata.name)}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const req: CreateKanbanRequest = {};
    if (displayName.trim()) req.displayName = displayName.trim();
    if (model.trim()) req.defaults = { model: model.trim() };
    req.defaults = { ...req.defaults, timeoutSeconds };
    req.maxParallel = maxParallel;

    if (showGit && gitUrl.trim()) {
      req.source = { git: { url: gitUrl.trim() } };
      if (gitRef.trim()) req.source!.git!.ref = gitRef.trim();
      if (gitSshSecret.trim()) req.source!.git!.sshSecret = { name: gitSshSecret.trim(), key: "ssh-privatekey" };
      if (gitAuthorName.trim() && gitAuthorEmail.trim()) {
        req.source!.git!.author = {
          name: gitAuthorName.trim(),
          email: gitAuthorEmail.trim(),
        };
      }
    }

    // If no tasks defined, create one default task.
    const tasks = buildTasks() ?? [];
    if (tasks.length > 0) {
      req.tasks = tasks;
    }

    if (agents.length > 0) {
      const validAgents = agents.filter((a) => a.name.trim() && a.content.trim());
      if (validAgents.length > 0) req.agents = validAgents;
    }

    mutation.mutate(req);
  }

  const inputClass =
    "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-zinc-500 focus:outline-none";

  return (
    <div className="space-y-6 max-w-2xl">
      <Link
        to="/kanbans"
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
      >
        <span>&larr;</span> All kanban boards
      </Link>

      <div>
        <h1 className="text-xl font-semibold">New Kanban Board</h1>
        <p className="text-sm text-text-muted mt-1">
          Create a board for agentic development. Tasks will be dispatched as worker runs by the manager controller.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Display name */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Display Name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My development board (optional)"
            className={inputClass}
          />
        </div>

        {/* Model + Timeout row */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="local/llama3.1-70b"
              className={inputClass + " font-mono"}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Timeout (seconds)</label>
            <input
              type="number"
              min={60}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
              className={inputClass + " tabular-nums"}
            />
          </div>
        </div>

        {/* Max parallel */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">
            Max Parallel Workers: {maxParallel}
          </label>
          <input
            type="range"
            min={1}
            max={20}
            value={maxParallel}
            onChange={(e) => setMaxParallel(Number(e.target.value))}
            className="w-full accent-zinc-500"
          />
          <p className="text-xs text-text-dim">
            WIP limit — how many tasks the manager dispatches concurrently. Default 2 for EliteDesk sizing with local LLM.
          </p>
        </div>

        {/* Cluster agent selector */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Cluster agents</label>
          <select
            value={selectedClusterAgent}
            onChange={(e) => handleClusterAgentSelect(e.target.value)}
            className={inputClass}
          >
            <option value="">— none —</option>
            {clusterAgents.map((ca) => (
              <option key={ca.name} value={ca.name}>{ca.name}</option>
            ))}
          </select>
        </div>

        {/* Inline agents */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-text-muted">Worker agents</label>
            <button
              type="button"
              onClick={addTask}
              disabled={agents.length >= 5}
              className="text-xs text-zinc-400 hover:text-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              + Add agent ({agents.length}/5)
            </button>
          </div>
          {agents.map((a, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border bg-surface p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-muted">Agent {i + 1}</span>
                <button
                  type="button"
                  onClick={() => removeAgent(i)}
                  disabled={agents.length <= 1}
                  className="text-xs text-phase-failed hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Remove
                </button>
              </div>
              <input
                type="text"
                value={a.name}
                onChange={(e) => updateAgent(i, "name", e.target.value)}
                placeholder="agent-name (used as filename and task ID)"
                className={inputClass + " font-mono"}
              />
              <textarea
                value={a.content}
                onChange={(e) => updateAgent(i, "content", e.target.value)}
                placeholder={`---\ndescription: What this agent does\n---\nSystem prompt...`}
                rows={6}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-zinc-500 focus:outline-none resize-y font-mono"
              />
              <p className="text-xs text-text-dim">
                {a.content.length > 0 ? `${(a.content.length / 1024).toFixed(1)} KB` : "Paste agent .md content here"}
                {a.content.length >= 102400 && (
                  <span className="text-phase-failed ml-1">— exceeds 100KB limit</span>
                )}
              </p>
            </div>
          ))}
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
                  className={inputClass + " font-mono"}
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
                  className={inputClass + " font-mono"}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-muted">SSH Secret</label>
                <input
                  type="text"
                  value={gitSshSecret}
                  onChange={(e) => setGitSshSecret(e.target.value)}
                  placeholder="git-ssh-key"
                  className={inputClass + " font-mono"}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-text-muted">Author name</label>
                  <input
                    type="text"
                    value={gitAuthorName}
                    onChange={(e) => setGitAuthorName(e.target.value)}
                    placeholder="Percussionist Agent"
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-text-muted">Author email</label>
                  <input
                    type="email"
                    value={gitAuthorEmail}
                    onChange={(e) => setGitAuthorEmail(e.target.value)}
                    placeholder="agent@percussionist.local"
                    className={inputClass + " font-mono"}
                  />
                </div>
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
            disabled={mutation.isPending}
            className="rounded-md bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-text transition-colors"
          >
            {mutation.isPending ? "Creating..." : "Create Board"}
          </button>
          <Link
            to="/kanbans"
            className="text-sm text-text-muted hover:text-text transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

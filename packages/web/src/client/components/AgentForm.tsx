import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAgent } from "../hooks/useAgent";
import { submitAgent, updateAgent as apiUpdateAgent } from "../lib/api";

export default function AgentForm() {
  const { name: editName } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = !!editName;

  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Load existing agent when editing.
  useEffect(() => {
    if (!isEdit) return;
    fetch(`/api/agents/${encodeURIComponent(editName!)}`)
      .then((r) => r.json())
      .then((data: { metadata?: { name?: string }; spec?: { content?: string } }) => {
        setName(data.metadata?.name ?? "");
        setContent(data.spec?.content ?? "");
      })
      .catch(() => {});
  }, [isEdit, editName]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      if (isEdit) {
        await apiUpdateAgent(name.trim(), { content });
      } else {
        await submitAgent({ name: name.trim(), content });
      }
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate("/agents");
    } catch (e) {
      console.error("Failed to save agent:", e);
    } finally {
      setSubmitting(false);
    }
  };

  const kbCount = content.length > 0 ? `${(content.length / 1024).toFixed(1)} KB` : "0 KB";

  return (
    <div className="space-y-6">
      {/* Navigation */}
      <Link
        to="/agents"
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
      >
        &larr; Back to agents
      </Link>

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">{isEdit ? `Edit "${name}"` : "New Agent"}</h1>
        <p className="text-sm text-text-muted mt-0.5">
          {isEdit
            ? `Update the agent definition for ${name}.`
            : "Define a cluster-scoped reusable agent prompt."}
        </p>
      </div>

      {/* Form */}
      <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="agent-name (lowercase alphanumeric + hyphens)"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm font-mono text-text placeholder:text-text-dim focus:outline-none focus:border-zinc-500"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`---\ndescription: What this agent does\nmode: primary\n---\nSystem prompt...`}
            rows={16}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm font-mono text-text placeholder:text-text-dim focus:outline-none focus:border-zinc-500 resize-y"
          />
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>YAML front-matter + system prompt</span>
            <span>{kbCount}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2 border-t border-border-muted">
          <button
            onClick={handleSave}
            disabled={!name.trim() || submitting}
            className="rounded-md bg-zinc-700 hover:bg-zinc-600 px-4 py-1.5 text-sm font-medium text-text transition-colors disabled:opacity-40"
          >
            {submitting ? "Saving\u2026" : isEdit ? "Save Changes" : "Create Agent"}
          </button>
          <Link
            to="/agents"
            className="text-sm text-text-muted hover:text-text transition-colors"
          >
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}

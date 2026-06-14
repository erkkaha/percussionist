import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { updateAgent as apiUpdateAgent, submitAgent } from '../lib/api';
import { authHeaders } from '../lib/auth';
import type { AgentCapability } from '../lib/types';
import ModelSelector from './ModelSelector';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

const CAPABILITIES: AgentCapability[] = [
  'task.plan.execute',
  'task.build.execute',
  'task.build.generate',
  'task.review.evaluate',
  'task.failure.analyze',
  'task.merge.execute',
  'run.complete.plan',
  'run.complete.build',
  'run.complete.review',
];

export default function AgentForm() {
  const { name: editName } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = !!editName;

  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [model, setModel] = useState('');
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Load existing agent when editing.
  useEffect(() => {
    if (!isEdit) return;
    if (!editName) return;
    fetch(`/api/agents/${encodeURIComponent(editName)}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then(
        (data: {
          metadata?: { name?: string };
          spec?: { content?: string; model?: string; capabilities?: AgentCapability[] };
        }) => {
          setName(data.metadata?.name ?? '');
          setContent(data.spec?.content ?? '');
          setModel(data.spec?.model ?? '');
          setCapabilities(data.spec?.capabilities ?? []);
        },
      )
      .catch(() => {});
  }, [isEdit, editName]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      if (isEdit) {
        await apiUpdateAgent(name.trim(), {
          content,
          model: model || undefined,
          capabilities: capabilities.length > 0 ? capabilities : undefined,
        });
      } else {
        await submitAgent({
          name: name.trim(),
          content,
          model: model || undefined,
          capabilities: capabilities.length > 0 ? capabilities : undefined,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate('/settings?tab=agents');
    } catch (e) {
      console.error('Failed to save agent:', e);
    } finally {
      setSubmitting(false);
    }
  };

  const kbCount = content.length > 0 ? `${(content.length / 1024).toFixed(1)} KB` : '0 KB';

  const toggleCapability = (capability: AgentCapability, checked: boolean) => {
    setCapabilities((prev) => {
      if (checked) {
        if (prev.includes(capability)) return prev;
        return [...prev, capability];
      }
      return prev.filter((c) => c !== capability);
    });
  };

  return (
    <div className="space-y-6">
      {/* Navigation */}
      <Link
        to="/settings?tab=agents"
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
      >
        &larr; Back to agents
      </Link>

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">{isEdit ? `Edit "${name}"` : 'New Agent'}</h1>
        <p className="text-sm text-text-muted mt-0.5">
          {isEdit
            ? `Update the agent definition for ${name}.`
            : 'Define a cluster-scoped reusable agent prompt.'}
        </p>
      </div>

      {/* Form */}
      <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Name</label>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="agent-name (lowercase alphanumeric + hyphens)"
            className="font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Model</label>
          <ModelSelector
            value={model}
            onChange={setModel}
            placeholder="e.g. anthropic/claude-sonnet-4-20250514"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Content</label>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`---\ndescription: What this agent does\nmode: primary\n---\nSystem prompt...`}
            rows={16}
            className="font-mono"
          />
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>YAML front-matter + system prompt</span>
            <span>{kbCount}</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-text-muted">Capabilities</div>
          <p className="text-xs text-text-dim">
            Select explicit capabilities this agent is allowed to perform.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {CAPABILITIES.map((capability) => (
              <label
                key={capability}
                className="flex items-center gap-2 rounded border border-border-muted px-2.5 py-2 text-sm font-mono"
              >
                <Checkbox
                  checked={capabilities.includes(capability)}
                  onCheckedChange={(value) => toggleCapability(capability, value === true)}
                />
                <span>{capability}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2 border-t border-border-muted">
          <Button onClick={handleSave} disabled={!name.trim() || submitting}>
            {submitting ? 'Saving\u2026' : isEdit ? 'Save Changes' : 'Create Agent'}
          </Button>
          <Link
            to="/settings?tab=agents"
            className="text-sm text-text-muted hover:text-text transition-colors"
          >
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}

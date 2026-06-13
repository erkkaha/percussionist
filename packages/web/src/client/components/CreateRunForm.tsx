import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjects } from '../hooks/useProjects';
import { useRun } from '../hooks/useRun';
import { submitRun } from '../lib/api';
import { authHeaders } from '../lib/auth';
import type { AgentDef, CreateRunRequest, Project, Run } from '../lib/types';
import ModelSelector from './ModelSelector';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

interface ClusterAgent {
  name: string;
  content: string;
}

async function fetchClusterAgents(): Promise<ClusterAgent[]> {
  const res = await fetch('/api/agents', { headers: authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.agents as ClusterAgent[]) ?? [];
}

export default function CreateRunForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: projects } = useProjects(false);
  const [searchParams] = useSearchParams();
  const copyFromName = searchParams.get('copyFrom') ?? undefined;

  const [selectedProject, setSelectedProject] = useState<string>('');
  const [task, setTask] = useState('');
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState('');
  const [interactive, setInteractive] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(3600);
  const [showGit, setShowGit] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [gitSshSecret, setGitSshSecret] = useState('');
  const [gitGithubTokenSecret, setGitGithubTokenSecret] = useState('');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');
  const [llmKeysSecret, setLlmKeysSecret] = useState('');
  const [authSecretName, setOpencodeAuthSecretName] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [clusterAgents, setClusterAgents] = useState<ClusterAgent[]>([]);
  const [selectedClusterAgent, setSelectedClusterAgent] = useState('');

  // Load available cluster agents on mount.
  useEffect(() => {
    fetchClusterAgents()
      .then(setClusterAgents)
      .catch(() => {});
  }, []);

  function addAgent() {
    if (agents.length >= 5) return;
    setAgents((prev) => [...prev, { name: '', content: '' }]);
  }

  function removeAgent(index: number) {
    setAgents((prev) => prev.filter((_, i) => i !== index));
  }

  function updateAgent(index: number, field: 'name' | 'content', value: string) {
    setAgents((prev) => prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)));
  }

  // When a cluster agent is selected, populate inline agents from it.
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

  const gitAuthorIncomplete =
    (gitAuthorName.trim().length > 0 && gitAuthorEmail.trim().length === 0) ||
    (gitAuthorName.trim().length === 0 && gitAuthorEmail.trim().length > 0);

  // Fetch the source run when ?copyFrom is set
  const { data: sourceRun } = useRun(copyFromName ?? '', 0);

  // Pre-fill form from the source run once it loads
  useEffect(() => {
    if (!sourceRun || seeded) return;
    applyRun(sourceRun);
    setSeeded(true);
  }, [sourceRun, seeded, applyRun]);

  function applyRun(run: Run) {
    if (run.spec.task) setTask(run.spec.task);
    if (run.spec.model) setModel(run.spec.model);
    if (run.spec.agent) setAgent(run.spec.agent);
    if (run.spec.inlineAgents && run.spec.inlineAgents.length > 0)
      setAgents([...run.spec.inlineAgents]);
    if (run.spec.interactive) setInteractive(run.spec.interactive);
    if (run.spec.timeoutSeconds) setTimeoutSeconds(run.spec.timeoutSeconds);
    if (run.spec.source?.git?.url) {
      setGitUrl(run.spec.source.git.url);
      setShowGit(true);
    }
    if (run.spec.source?.git?.ref) setGitRef(run.spec.source.git.ref);
    if (run.spec.source?.git?.sshSecret?.name) setGitSshSecret(run.spec.source.git.sshSecret.name);
    if (run.spec.source?.git?.githubTokenSecret?.name)
      setGitGithubTokenSecret(run.spec.source.git.githubTokenSecret.name);
    if (run.spec.source?.git?.author?.name) setGitAuthorName(run.spec.source.git.author.name);
    if (run.spec.source?.git?.author?.email) setGitAuthorEmail(run.spec.source.git.author.email);
    if (run.spec.secrets?.llmKeysSecret) setLlmKeysSecret(run.spec.secrets.llmKeysSecret);
    if (run.spec.secrets?.authSecret?.name)
      setOpencodeAuthSecretName(run.spec.secrets.authSecret.name);
  }

  function applyProject(proj: Project) {
    if (proj.spec.model) setModel(proj.spec.model);
    if (proj.spec.agent) setAgent(proj.spec.agent);
    if (proj.spec.source?.git?.url) {
      setGitUrl(proj.spec.source.git.url);
      setShowGit(true);
    }
    if (proj.spec.source?.git?.ref) setGitRef(proj.spec.source.git.ref);
    if (proj.spec.source?.git?.sshSecret?.name)
      setGitSshSecret(proj.spec.source.git.sshSecret.name);
    if (proj.spec.source?.git?.githubTokenSecret?.name)
      setGitGithubTokenSecret(proj.spec.source.git.githubTokenSecret.name);
    if (proj.spec.source?.git?.author?.name) setGitAuthorName(proj.spec.source.git.author.name);
    if (proj.spec.source?.git?.author?.email) setGitAuthorEmail(proj.spec.source.git.author.email);
    if (proj.spec.secrets?.llmKeysSecret) setLlmKeysSecret(proj.spec.secrets.llmKeysSecret);
    if (proj.spec.secrets?.authSecret?.name)
      setOpencodeAuthSecretName(proj.spec.secrets.authSecret.name);
  }

  // Cluster agents visible in the dropdown — filtered to project roster when a project is selected.
  const selectedProjectObj = projects?.find((p) => p.metadata.name === selectedProject);
  const selectedProjectSpec = selectedProjectObj?.spec;
  const rosterNames = selectedProjectSpec?.agents?.map((a) => a.name) ?? [];
  const visibleAgents =
    rosterNames.length > 0
      ? clusterAgents.filter((ca) => rosterNames.includes(ca.name))
      : clusterAgents;

  // When a project is selected, git and secrets are inherited from it — hide those fields.
  const projectHasGit = !!selectedProjectSpec?.source?.git?.url;
  const projectHasSecrets = !!(
    selectedProjectSpec?.secrets?.llmKeysSecret || selectedProjectSpec?.secrets?.authSecret?.name
  );

  function handleProjectChange(name: string) {
    setSelectedProject(name);
    setSelectedClusterAgent('');
    setAgents([]);
    if (!name) return;
    const proj = projects?.find((p) => p.metadata.name === name);
    if (proj) applyProject(proj);
  }

  const mutation = useMutation({
    mutationFn: (req: CreateRunRequest) => submitRun(req),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      navigate(`/runs/${encodeURIComponent(run.metadata.name)}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const req: CreateRunRequest = { interactive, timeoutSeconds, project: selectedProject };
    if (task.trim()) req.task = task.trim();
    if (model.trim()) req.model = model.trim();
    if (agent.trim()) req.agent = agent.trim();
    if (agents.length > 0) req.inlineAgents = agents;
    if (showGit && gitUrl.trim()) {
      req.source = { git: { url: gitUrl.trim() } };
      if (gitRef.trim()) req.source.git!.ref = gitRef.trim();
      if (gitSshSecret.trim()) req.source.git!.sshSecret = { name: gitSshSecret.trim() };
      if (gitGithubTokenSecret.trim())
        req.source.git!.githubTokenSecret = { name: gitGithubTokenSecret.trim() };
      if (gitAuthorName.trim() && gitAuthorEmail.trim()) {
        req.source.git!.author = {
          name: gitAuthorName.trim(),
          email: gitAuthorEmail.trim(),
        };
      }
    }
    if (llmKeysSecret.trim() || authSecretName.trim()) {
      req.secrets = {};
      if (llmKeysSecret.trim()) req.secrets.llmKeysSecret = llmKeysSecret.trim();
      if (authSecretName.trim()) req.secrets.authSecret = { name: authSecretName.trim() };
    }
    mutation.mutate(req);
  }

  const canSubmit =
    (interactive || task.trim().length > 0) && !gitAuthorIncomplete && selectedProject.length > 0;

  return (
    <div className="space-y-6 max-w-2xl">
      <Link
        to={copyFromName ? `/runs/${encodeURIComponent(copyFromName)}` : '/'}
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
      >
        <span>&larr;</span> {copyFromName ? `Back to ${copyFromName}` : 'All runs'}
      </Link>

      <div>
        <h1 className="text-xl font-semibold">{copyFromName ? 'Copy Run' : 'New Run'}</h1>
        <p className="text-sm text-text-muted mt-1">
          {copyFromName
            ? `Pre-filled from run \u201c${copyFromName}\u201d, including Secret references.`
            : 'Submit a task for an OpenCode agent to work on.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Project picker — required */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">
            Project <span className="text-phase-failed">*</span>
          </label>
          <Select value={selectedProject} onValueChange={(v) => handleProjectChange(v)}>
            <SelectTrigger className="bg-surface">
              <SelectValue placeholder="— select a project —" />
            </SelectTrigger>
            <SelectContent>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.metadata.name} value={p.metadata.name}>
                  {p.spec.displayName ?? p.metadata.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!selectedProject && (
            <p className="text-xs text-text-dim">
              A project is required.{' '}
              <Link
                to="/projects/new"
                className="underline hover:text-text-muted transition-colors"
              >
                Create one
              </Link>
            </p>
          )}
        </div>

        {/* Interactive toggle */}
        <div className="flex items-center gap-3">
          <Switch checked={interactive} onCheckedChange={(v) => setInteractive(v)} />
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
          <Textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={interactive}
            rows={5}
            placeholder={
              interactive
                ? 'Not required in interactive mode'
                : 'Describe what the agent should do...'
            }
          />
        </div>

        {/* Model + Agent row */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Model</label>
            <ModelSelector
              value={model}
              onChange={setModel}
              placeholder="e.g. anthropic/claude-sonnet-4-20250514"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Agent</label>
            <Input
              type="text"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="e.g. build"
            />
          </div>
        </div>

        {/* Cluster agent selector */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Cluster agents</label>
          <Select value={selectedClusterAgent} onValueChange={(v) => handleClusterAgentSelect(v)}>
            <SelectTrigger>
              <SelectValue placeholder="— none —" />
            </SelectTrigger>
            <SelectContent>
              {visibleAgents.map((ca) => (
                <SelectItem key={ca.name} value={ca.name}>
                  {ca.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Inline agents */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-text-muted">Inline agents</label>
            <button
              type="button"
              onClick={addAgent}
              disabled={agents.length >= 5}
              className="text-xs text-text-dim hover:text-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              + Add agent ({agents.length}/5)
            </button>
          </div>
          {agents.map((a, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border bg-surface p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-muted">Agent {i + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAgent(i)}
                  disabled={agents.length <= 1}
                  className="text-phase-failed hover:text-red-400 disabled:opacity-30"
                >
                  Remove
                </Button>
              </div>
              <Input
                type="text"
                value={a.name}
                onChange={(e) => updateAgent(i, 'name', e.target.value)}
                placeholder="agent-name (used as filename)"
                className="font-mono"
              />
              <Textarea
                value={a.content}
                onChange={(e) => updateAgent(i, 'content', e.target.value)}
                placeholder={`---\ndescription: What this agent does\n---\nSystem prompt...`}
                rows={6}
                className="font-mono"
              />
              <p className="text-xs text-text-dim">
                {a.content.length > 0
                  ? `${(a.content.length / 1024).toFixed(1)} KB`
                  : 'Paste agent .md content here'}
                {a.content.length >= 102400 && (
                  <span className="text-phase-failed ml-1">— exceeds 100KB limit</span>
                )}
              </p>
            </div>
          ))}
        </div>

        {/* Secrets row — hidden when project is selected (inherited from project) */}
        {!projectHasSecrets && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-text-muted">Kubernetes Secret references</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-muted">LLM keys Secret name</label>
                <Input
                  type="text"
                  value={llmKeysSecret}
                  onChange={(e) => setLlmKeysSecret(e.target.value)}
                  placeholder="llm-keys"
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">
                  Secret whose keys are injected as env vars (API keys).
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-muted">
                  OpenCode auth Secret name
                </label>
                <Input
                  type="text"
                  value={authSecretName}
                  onChange={(e) => setOpencodeAuthSecretName(e.target.value)}
                  placeholder="opencode-auth"
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">
                  Secret holding <code className="font-mono">auth.json</code> for OAuth providers.
                  Populate with <code className="font-mono">beatctl auth import</code>.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Timeout */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Timeout (seconds)</label>
          <Input
            type="number"
            min={1}
            value={timeoutSeconds}
            onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
            className="w-40 tabular-nums"
          />
        </div>

        {/* Git source — hidden when project provides it (inherited automatically) */}
        {projectHasGit ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-text-muted">Git source</p>
            <p className="text-sm text-text-dim">
              Inherited from project:{' '}
              <span className="font-mono text-text">{selectedProjectSpec?.source?.git?.url}</span>
              {selectedProjectSpec?.source?.git?.ref && (
                <span className="text-text-dim">
                  {' '}
                  @{' '}
                  <span className="font-mono text-text">{selectedProjectSpec.source.git.ref}</span>
                </span>
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setShowGit((v) => !v)}
              className="flex items-center gap-2 text-sm text-text-muted hover:text-text transition-colors"
            >
              <span className={`transition-transform ${showGit ? 'rotate-90' : ''}`}>▶</span>
              Git source (optional)
            </button>
            {showGit && (
              <div className="pl-4 border-l border-border-muted space-y-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-text-muted">Repository URL</label>
                  <Input
                    type="text"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    placeholder="https://github.com/org/repo.git"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-text-muted">
                    Ref <span className="text-text-dim font-normal">(branch / tag / SHA)</span>
                  </label>
                  <Input
                    type="text"
                    value={gitRef}
                    onChange={(e) => setGitRef(e.target.value)}
                    placeholder="main"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-text-muted">SSH Secret</label>
                  <Input
                    type="text"
                    value={gitSshSecret}
                    onChange={(e) => setGitSshSecret(e.target.value)}
                    placeholder="git-ssh-key"
                    className="font-mono"
                  />
                  <p className="text-xs text-text-dim">
                    Secret name from <code className="font-mono">beatctl ssh-key create</code>
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-text-muted">GitHub Token Secret</label>
                  <Input
                    type="text"
                    value={gitGithubTokenSecret}
                    onChange={(e) => setGitGithubTokenSecret(e.target.value)}
                    placeholder="git-github-token"
                    className="font-mono"
                  />
                  <p className="text-xs text-text-dim">
                    Secret name from <code className="font-mono">beatctl github-token create</code>{' '}
                    — authenticates <code className="font-mono">gh</code> CLI in the runner
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-text-muted">Author name</label>
                    <Input
                      type="text"
                      value={gitAuthorName}
                      onChange={(e) => setGitAuthorName(e.target.value)}
                      placeholder="Percussionist Agent"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-text-muted">Author email</label>
                    <Input
                      type="email"
                      value={gitAuthorEmail}
                      onChange={(e) => setGitAuthorEmail(e.target.value)}
                      placeholder="agent@example.com"
                      className="font-mono"
                    />
                  </div>
                </div>
                {gitAuthorIncomplete && (
                  <p className="text-xs text-phase-failed">
                    Git author requires both name and email.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {mutation.error && (
          <div className="rounded-md border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container">
            {mutation.error.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending ? 'Submitting...' : 'Submit Run'}
          </Button>
          <Link to="/" className="text-sm text-text-muted hover:text-text transition-colors">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

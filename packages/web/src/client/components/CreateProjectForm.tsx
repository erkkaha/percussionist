import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { submitProject, updateProject, fetchAgents } from "../lib/api";
import type { CreateProjectRequest, ProjectDetail } from "../lib/types";

type CreateProjectFormProps = {
  mode?: "create" | "edit";
  initialProject?: ProjectDetail;
};

// Sidecar row state — env is edited as a single "KEY=value\nKEY=value" text block.
interface SidecarRow {
  id: number; // local key only
  name: string;
  image: string;
  ports: string; // comma-separated numbers
  env: string;   // newline-separated KEY=VALUE pairs
}

let _sidecarIdSeq = 0;
function nextSidecarId() { return ++_sidecarIdSeq; }

// Inject file row state.
interface InjectFileRow {
  id: number; // local key only
  filename: string;
  content: string;
}

let _injectFileIdSeq = 0;
function nextInjectFileId() { return ++_injectFileIdSeq; }

function initialInjectFileRows(project: ProjectDetail | undefined): InjectFileRow[] {
  const contents = project?.injectFileContents ?? [];
  return contents.map((f) => ({
    id: nextInjectFileId(),
    filename: f.filename,
    content: f.content,
  }));
}

function initialSidecarRows(spec: ProjectDetail["spec"] | undefined): SidecarRow[] {
  if (!spec?.sidecars?.length) return [];
  return spec.sidecars.map((sc) => ({
    id: nextSidecarId(),
    name: sc.name,
    image: sc.image,
    ports: (sc.ports ?? []).join(", "),
    env: (sc.env ?? []).map((e: { name: string; value: string }) => `${e.name}=${e.value}`).join("\n"),
  }));
}

export default function CreateProjectForm({
  mode = "create",
  initialProject,
}: CreateProjectFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = mode === "edit";

  const initialSpec = initialProject?.spec;

  const [name, setName] = useState(initialProject?.metadata.name ?? "");
  const [displayName, setDisplayName] = useState(initialSpec?.displayName ?? "");
  const [model, setModel] = useState(initialSpec?.model ?? "");
  const [agent, setAgent] = useState(initialSpec?.agent ?? "");
  const [gitUrl, setGitUrl] = useState(initialSpec?.source?.git?.url ?? "");
  const [gitRef, setGitRef] = useState(initialSpec?.source?.git?.ref ?? "");
  const [gitSshSecret, setGitSshSecret] = useState(initialSpec?.source?.git?.sshSecret?.name ?? "");
  const [gitGithubTokenSecret, setGitGithubTokenSecret] = useState(initialSpec?.source?.git?.githubTokenSecret?.name ?? "");
  const [gitAuthorName, setGitAuthorName] = useState(initialSpec?.source?.git?.author?.name ?? "");
  const [gitAuthorEmail, setGitAuthorEmail] = useState(initialSpec?.source?.git?.author?.email ?? "");
  const [llmKeysSecret, setLlmKeysSecret] = useState(initialSpec?.secrets?.llmKeysSecret ?? "");
  const [authSecret, setAuthSecret] = useState(initialSpec?.secrets?.authSecret?.name ?? "");
  const [initScript, setInitScript] = useState(initialSpec?.initScript ?? "");
  const [opencodeConfig, setOpencodeConfig] = useState("");
  const [sidecars, setSidecars] = useState<SidecarRow[]>(() => initialSidecarRows(initialSpec));
  const [injectFiles, setInjectFiles] = useState<InjectFileRow[]>(() => initialInjectFileRows(initialProject));
  const [rosterAgents, setRosterAgents] = useState<string[]>(
    () => (initialSpec?.agents ?? []).map((a: { name: string }) => a.name),
  );
  const [rosterPickerValue, setRosterPickerValue] = useState("");
  const [maxParallel, setMaxParallel] = useState<string>(
    initialSpec?.maxParallel !== undefined ? String(initialSpec.maxParallel) : "",
  );
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>(
    initialSpec?.timeoutSeconds !== undefined ? String(initialSpec.timeoutSeconds) : "",
  );
  const [featureBranchingEnabled, setFeatureBranchingEnabled] = useState<boolean>(
    initialSpec?.featureBranchingEnabled ?? false,
  );

  // All ClusterAgents in cluster — used to populate the roster add dropdown.
  const { data: clusterAgents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
  });

  // Sidecar helpers
  function addSidecar() {
    setSidecars((prev) => [...prev, { id: nextSidecarId(), name: "", image: "", ports: "", env: "" }]);
  }
  function removeSidecar(id: number) {
    setSidecars((prev) => prev.filter((sc) => sc.id !== id));
  }
  function updateSidecar(id: number, field: keyof Omit<SidecarRow, "id">, value: string) {
    setSidecars((prev) => prev.map((sc) => sc.id === id ? { ...sc, [field]: value } : sc));
  }

  // Inject file helpers
  function addInjectFile() {
    setInjectFiles((prev) => [...prev, { id: nextInjectFileId(), filename: "", content: "" }]);
  }
  function removeInjectFile(id: number) {
    setInjectFiles((prev) => prev.filter((f) => f.id !== id));
  }
  function updateInjectFile(id: number, field: keyof Omit<InjectFileRow, "id">, value: string) {
    setInjectFiles((prev) => prev.map((f) => f.id === id ? { ...f, [field]: value } : f));
  }

  // Validate sidecar rows: name and image are required; ports must be valid integers.
  const sidecarErrors: Record<number, string> = {};
  for (const sc of sidecars) {
    if (!sc.name.trim()) { sidecarErrors[sc.id] = "Name is required"; continue; }
    if (!sc.image.trim()) { sidecarErrors[sc.id] = "Image is required"; continue; }
    if (sc.ports.trim()) {
      const bad = sc.ports.split(",").map((p) => p.trim()).filter(Boolean).find((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535);
      if (bad) { sidecarErrors[sc.id] = `Invalid port: ${bad}`; continue; }
    }
  }
  const hasSidecarErrors = Object.keys(sidecarErrors).length > 0;

  // Validate inject file rows: filename required, no path separators.
  const injectFileErrors: Record<number, string> = {};
  for (const f of injectFiles) {
    if (!f.filename.trim()) { injectFileErrors[f.id] = "Filename is required"; continue; }
    if (f.filename.includes("/") || f.filename.includes("\\")) { injectFileErrors[f.id] = "Filename must not contain path separators"; continue; }
  }
  const hasInjectFileErrors = Object.keys(injectFileErrors).length > 0;

  const gitAuthorIncomplete =
    (gitAuthorName.trim().length > 0 && gitAuthorEmail.trim().length === 0) ||
    (gitAuthorName.trim().length === 0 && gitAuthorEmail.trim().length > 0);

  const configJsonError = (() => {
    if (!opencodeConfig?.trim()) return null;
    try { JSON.parse(opencodeConfig); return null; }
    catch (e) { return (e as Error).message; }
  })();

  const mutation = useMutation({
    mutationFn: (req: CreateProjectRequest) => {
      if (isEdit && initialProject) {
        return updateProject(initialProject.metadata.name, req);
      }
      return submitProject(req);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/settings?tab=projects");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (configJsonError) return;
    if (hasSidecarErrors) return;
    if (hasInjectFileErrors) return;
    const req: CreateProjectRequest = {};
    if (!isEdit && name.trim()) req.name = name.trim();
    if (displayName.trim()) req.displayName = displayName.trim();
    if (model.trim()) req.model = model.trim();
    if (agent.trim()) req.agent = agent.trim();
    if (opencodeConfig !== null) req.opencodeConfig = opencodeConfig.trim() || "";
    if (gitUrl.trim()) {
      req.source = {
        git: {
          url: gitUrl.trim(),
          ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
          ...(gitSshSecret.trim()
            ? { sshSecret: { name: gitSshSecret.trim() } }
            : {}),
          ...(gitGithubTokenSecret.trim()
            ? { githubTokenSecret: { name: gitGithubTokenSecret.trim() } }
            : {}),
          ...(gitAuthorName.trim() && gitAuthorEmail.trim()
            ? {
                author: {
                  name: gitAuthorName.trim(),
                  email: gitAuthorEmail.trim(),
                },
              }
            : {}),
        },
      };
    }
    if (llmKeysSecret.trim() || authSecret.trim()) {
      req.secrets = {
        ...(llmKeysSecret.trim() ? { llmKeysSecret: llmKeysSecret.trim() } : {}),
        ...(authSecret.trim()
          ? { authSecret: { name: authSecret.trim() } }
          : {}),
      };
    }
    if (initScript.trim()) {
      req.initScript = initScript.trim();
    }
    req.sidecars = sidecars.length > 0
      ? sidecars.map((sc) => {
          const ports = sc.ports.trim()
            ? sc.ports.split(",").map((p) => parseInt(p.trim(), 10)).filter(Boolean)
            : undefined;
          const env = sc.env.trim()
            ? sc.env.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
                const eq = line.indexOf("=");
                return eq >= 1
                  ? { name: line.slice(0, eq), value: line.slice(eq + 1) }
                  : { name: line, value: "" };
              })
            : undefined;
          return {
            name: sc.name.trim(),
            image: sc.image.trim(),
            ...(ports?.length ? { ports } : {}),
            ...(env?.length ? { env } : {}),
          };
        })
      : [];
    // Always send injectFiles (even empty array) so server can delete orphans on update.
    req.injectFiles = injectFiles
      .filter((f) => f.filename.trim())
      .map((f) => ({ filename: f.filename.trim(), content: f.content }));
    // Always send agents (even empty) so server can clear roster on update.
    req.agents = rosterAgents.map((name) => ({ name }));
    const parsedMaxParallel = maxParallel.trim() ? parseInt(maxParallel.trim(), 10) : NaN;
    if (!isNaN(parsedMaxParallel) && parsedMaxParallel > 0) req.maxParallel = parsedMaxParallel;
    const parsedTimeout = timeoutSeconds.trim() ? parseInt(timeoutSeconds.trim(), 10) : NaN;
    if (!isNaN(parsedTimeout) && parsedTimeout > 0) req.timeoutSeconds = parsedTimeout;
    req.featureBranchingEnabled = featureBranchingEnabled;
    mutation.mutate(req);
  }

  const inputClass =
    "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-accent/60 focus:outline-none";
  const monoInputClass = inputClass + " font-mono";

  return (
    <div className="space-y-6 max-w-2xl">
      <Link
        to="/settings?tab=projects"
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
      >
        <span>&larr;</span> All projects
      </Link>

      <div>
        <h1 className="text-xl font-semibold">{isEdit ? "Edit Project" : "New Project"}</h1>
        <p className="text-sm text-text-muted mt-1">
          {isEdit
            ? "Update reusable defaults for this project."
            : "Save reusable defaults — git URL, secrets, model — under a short name. Pick this project when creating a run to pre-fill those fields."}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {isEdit ? (
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Name</label>
            <input
              type="text"
              value={name}
              readOnly
              className={monoInputClass + " opacity-70"}
            />
          </div>
        ) : (
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
        )}

        {isEdit && (
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
        )}

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
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">GitHub Token Secret</label>
            <input
              type="text"
              value={gitGithubTokenSecret}
              onChange={(e) => setGitGithubTokenSecret(e.target.value)}
              placeholder="git-github-token"
              className={monoInputClass}
            />
            <p className="text-xs text-text-dim">
              Secret name from{" "}
              <code className="font-mono">beatctl github-token create</code>
              {" "}— authenticates <code className="font-mono">gh</code> CLI in the runner
            </p>
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
                placeholder="agent@example.com"
                className={monoInputClass}
              />
            </div>
          </div>
          {gitAuthorIncomplete && (
            <p className="text-xs text-phase-failed">
              Git author requires both name and email.
            </p>
          )}
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

        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Max Parallel Tasks</label>
            <input
              type="number"
              min={1}
              value={maxParallel}
              onChange={(e) => setMaxParallel(e.target.value)}
              placeholder="2"
              className={monoInputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Timeout (seconds)</label>
            <input
              type="number"
              min={1}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              placeholder="3600"
              className={monoInputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Feature Branching</label>
            <label className="flex items-center gap-2 cursor-pointer h-9">
              <input
                type="checkbox"
                checked={featureBranchingEnabled}
                onChange={(e) => setFeatureBranchingEnabled(e.target.checked)}
                className="rounded border-border"
              />
              <span className="text-sm text-text-muted">Enable per-task branches</span>
            </label>
          </div>
        </div>

        {/* OpenCode Config */}
        <fieldset className="rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium text-text-muted">OpenCode config</legend>
          <p className="text-xs text-text-dim mb-2">
            Configure OpenCode at the project level. To set cluster-wide OpenCode config, use{" "}
            <Link to="/settings" className="underline hover:text-text">Settings</Link>.
          </p>
          <textarea
            value={opencodeConfig ?? ""}
            onChange={(e) => setOpencodeConfig(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'{\n  "providers": [...],\n  "mcp": {...}\n}'}
            className={monoInputClass + " resize-y text-xs leading-5 w-full"}
          />
          {configJsonError && (
            <p className="text-xs text-phase-failed mt-1">Invalid JSON: {configJsonError}</p>
          )}
        </fieldset>

        {/* Sidecars */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium text-text-muted">Sidecars</legend>
          <p className="text-xs text-text-dim">
            Extra containers injected into every run pod alongside the agent — e.g. a test database.
            The agent reaches them via <code className="font-mono">localhost</code>.
            opencode waits for all declared ports to be reachable before starting.
          </p>

          {sidecars.length > 0 && (
            <div className="space-y-4">
              {sidecars.map((sc, idx) => (
                <div key={sc.id} className="rounded-md border border-border-muted p-3 space-y-3 relative">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-text-muted">Sidecar {idx + 1}</span>
                    <button
                      type="button"
                      onClick={() => removeSidecar(sc.id)}
                      className="text-xs text-text-dim hover:text-phase-failed transition-colors"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-text-muted">
                        Name <span className="text-phase-failed">*</span>
                      </label>
                      <input
                        type="text"
                        value={sc.name}
                        onChange={(e) => updateSidecar(sc.id, "name", e.target.value)}
                        placeholder="postgres"
                        className={monoInputClass}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-text-muted">
                        Image <span className="text-phase-failed">*</span>
                      </label>
                      <input
                        type="text"
                        value={sc.image}
                        onChange={(e) => updateSidecar(sc.id, "image", e.target.value)}
                        placeholder="postgres:16-alpine"
                        className={monoInputClass}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-muted">
                      Ports{" "}
                      <span className="text-text-dim font-normal">(comma-separated)</span>
                    </label>
                    <input
                      type="text"
                      value={sc.ports}
                      onChange={(e) => updateSidecar(sc.id, "ports", e.target.value)}
                      placeholder="5432"
                      className={monoInputClass}
                    />
                    <p className="text-xs text-text-dim">
                      opencode waits for these ports before starting.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-muted">
                      Environment{" "}
                      <span className="text-text-dim font-normal">(one KEY=VALUE per line)</span>
                    </label>
                    <textarea
                      value={sc.env}
                      onChange={(e) => updateSidecar(sc.id, "env", e.target.value)}
                      rows={3}
                      spellCheck={false}
                      placeholder={"POSTGRES_PASSWORD=test\nPOSTGRES_DB=testdb"}
                      className={monoInputClass + " resize-y text-xs leading-5"}
                    />
                  </div>

                  {sidecarErrors[sc.id] && (
                    <p className="text-xs text-phase-failed">{sidecarErrors[sc.id]}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={addSidecar}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text hover:border-accent/60 transition-colors"
          >
            + Add sidecar
          </button>
        </fieldset>

        {/* Injected Files */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium text-text-muted">Injected Files</legend>
          <p className="text-xs text-text-dim">
            Files written into <code className="font-mono">/workspace/</code> inside every run pod.
            Content is stored as K8s Secrets. Useful for <code className="font-mono">.env</code> files or other config files the agent needs.
          </p>

          {injectFiles.length > 0 && (
            <div className="space-y-4">
              {injectFiles.map((f, idx) => (
                <div key={f.id} className="rounded-md border border-border-muted p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-text-muted">File {idx + 1}</span>
                    <button
                      type="button"
                      onClick={() => removeInjectFile(f.id)}
                      className="text-xs text-text-dim hover:text-phase-failed transition-colors"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-muted">
                      Filename <span className="text-phase-failed">*</span>
                      <span className="text-text-dim font-normal ml-1">(mounted at /workspace/&lt;filename&gt;)</span>
                    </label>
                    <input
                      type="text"
                      value={f.filename}
                      onChange={(e) => updateInjectFile(f.id, "filename", e.target.value)}
                      placeholder=".env"
                      className={monoInputClass}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-muted">Content</label>
                    <textarea
                      value={f.content}
                      onChange={(e) => updateInjectFile(f.id, "content", e.target.value)}
                      rows={8}
                      spellCheck={false}
                      placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=..."}
                      className={monoInputClass + " resize-y text-xs leading-5"}
                    />
                  </div>

                  {injectFileErrors[f.id] && (
                    <p className="text-xs text-phase-failed">{injectFileErrors[f.id]}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={addInjectFile}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text hover:border-accent/60 transition-colors"
          >
            + Add file
          </button>
        </fieldset>

        {/* Init Script */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium text-text-muted">Init script</legend>
          <p className="text-xs text-text-dim">
            Shell script to run after git clone completes, before opencode starts.
            Runs in the init container — failure (non-zero exit) will prevent the pod from starting.
            Working directory is <code className="font-mono">/workspace</code> (the cloned repo root).
          </p>
          <textarea
            value={initScript}
            onChange={(e) => setInitScript(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={"npm ci\nnpm run build"}
            className={monoInputClass + " resize-y text-xs leading-5 font-mono"}
          />
        </fieldset>

        {/* Agent roster */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium text-text-muted">Agent roster</legend>
          <p className="text-xs text-text-dim">
            ClusterAgents available to tasks in this project. Tasks must reference an agent from this list.
          </p>
          {rosterAgents.length > 0 && (
            <ul className="space-y-1">
              {rosterAgents.map((agentName) => (
                <li key={agentName} className="flex items-center justify-between rounded border border-border bg-surface-raised px-3 py-1.5 text-sm">
                  <span className="font-mono">{agentName}</span>
                  <button
                    type="button"
                    onClick={() => setRosterAgents((prev) => prev.filter((n) => n !== agentName))}
                    className="text-text-dim hover:text-phase-failed transition-colors text-xs ml-4"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <select
              value={rosterPickerValue}
              onChange={(e) => setRosterPickerValue(e.target.value)}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            >
              <option value="">— add agent —</option>
              {clusterAgents
                .filter((a) => !rosterAgents.includes(a.name))
                .map((a) => <option key={a.name} value={a.name}>{a.name}</option>)
              }
            </select>
            <button
              type="button"
              disabled={!rosterPickerValue}
              onClick={() => {
                if (rosterPickerValue && !rosterAgents.includes(rosterPickerValue)) {
                  setRosterAgents((prev) => [...prev, rosterPickerValue]);
                  setRosterPickerValue("");
                }
              }}
              className="rounded-md border border-border hover:bg-surface-raised disabled:opacity-40 px-3 py-1.5 text-sm transition-colors"
            >
              Add
            </button>
          </div>
        </fieldset>

        {mutation.error && (
          <div className="rounded-md border border-phase-failed/30 bg-phase-failed/10 px-4 py-3 text-sm text-phase-failed">
            {mutation.error.message}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={(!isEdit && !name.trim()) || mutation.isPending || gitAuthorIncomplete || !!configJsonError || hasSidecarErrors || hasInjectFileErrors}
            className="rounded-md bg-[#5c4a3a] hover:bg-[#6b5948] disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-text transition-colors"
          >
            {mutation.isPending ? (isEdit ? "Saving…" : "Creating…") : (isEdit ? "Save Changes" : "Create Project")}
          </button>
          <Link to="/settings?tab=projects" className="text-sm text-text-muted hover:text-text transition-colors">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

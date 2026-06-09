import type { ProjectFormHookReturn } from "./useProjectForm";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

interface AdvancedTabProps {
  form: Pick<ProjectFormHookReturn, "sidecars" | "injectFiles" | "initScript" | "rosterAgents" | "rosterPickerValue" | "sidecarErrors" | "hasSidecarErrors" | "injectFileErrors" | "hasInjectFileErrors"> &
    Pick<ProjectFormHookReturn, "setSidecars" | "setInjectFiles" | "setInitScript" | "setRosterAgents" | "setRosterPickerValue" | "addSidecar" | "removeSidecar" | "updateSidecar" | "addInjectFile" | "removeInjectFile" | "updateInjectFile">;
  clusterAgents: Array<{ name: string; content: string }>;
}

export default function AdvancedTab({ form, clusterAgents }: AdvancedTabProps) {

  return (
    <div className="space-y-5">
      {/* Sidecars */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Sidecars</legend>
        <p className="text-xs text-text-dim">
          Extra containers injected into every run pod alongside the agent — e.g. a test database.
          The agent reaches them via <code className="font-mono">localhost</code>.
          opencode waits for all declared ports to be reachable before starting.
        </p>

        {form.sidecars.length > 0 && (
          <div className="space-y-4">
            {form.sidecars.map((sc, idx) => (
              <div key={sc.id} className="rounded-md border border-border-muted p-3 space-y-3 relative">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-muted">Sidecar {idx + 1}</span>
                  <button
                    type="button"
                    onClick={() => form.removeSidecar(sc.id)}
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
                    <Input
                      type="text"
                      value={sc.name}
                      onChange={(e) => form.updateSidecar(sc.id, "name", e.target.value)}
                      placeholder="postgres"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-muted">
                      Image <span className="text-phase-failed">*</span>
                    </label>
                    <Input
                      type="text"
                      value={sc.image}
                      onChange={(e) => form.updateSidecar(sc.id, "image", e.target.value)}
                      placeholder="postgres:16-alpine"
                      className="font-mono"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-muted">
                    Ports{" "}
                    <span className="text-text-dim font-normal">(comma-separated)</span>
                  </label>
                  <Input
                    type="text"
                    value={sc.ports}
                    onChange={(e) => form.updateSidecar(sc.id, "ports", e.target.value)}
                    placeholder="5432"
                    className="font-mono"
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
                  <Textarea
                    value={sc.env}
                    onChange={(e) => form.updateSidecar(sc.id, "env", e.target.value)}
                    rows={3}
                    spellCheck={false}
                    placeholder={"POSTGRES_PASSWORD=test\nPOSTGRES_DB=testdb"}
                    className="font-mono text-xs leading-5"
                  />
                </div>

                {form.sidecarErrors[sc.id] && (
                  <p className="text-xs text-phase-failed">{form.sidecarErrors[sc.id]}</p>
                )}
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={form.addSidecar}
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

        {form.injectFiles.length > 0 && (
          <div className="space-y-4">
            {form.injectFiles.map((f, idx) => (
              <div key={f.id} className="rounded-md border border-border-muted p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-muted">File {idx + 1}</span>
                  <button
                    type="button"
                    onClick={() => form.removeInjectFile(f.id)}
                    className="text-xs text-text-dim hover:text-phase-failed transition-colors"
                  >
                    Remove
                  </button>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-muted">
                    Filename <span className="text-text-dim font-normal ml-1">(mounted at /workspace/&lt;filename&gt;)</span>
                  </label>
                  <Input
                    type="text"
                    value={f.filename}
                    onChange={(e) => form.updateInjectFile(f.id, "filename", e.target.value)}
                    placeholder=".env"
                    className="font-mono"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-muted">Content</label>
                  <Textarea
                    value={f.content}
                    onChange={(e) => form.updateInjectFile(f.id, "content", e.target.value)}
                    rows={8}
                    spellCheck={false}
                    placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=..."}
                    className="font-mono text-xs leading-5"
                  />
                </div>

                {form.injectFileErrors[f.id] && (
                  <p className="text-xs text-phase-failed">{form.injectFileErrors[f.id]}</p>
                )}
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={form.addInjectFile}
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
        <Textarea
          value={form.initScript}
          onChange={(e) => form.setInitScript(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={"npm ci\nnpm run build"}
          className="font-mono text-xs leading-5"
        />
      </fieldset>

      {/* Agent roster */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Agent roster</legend>
        <p className="text-xs text-text-dim">
          ClusterAgents available to tasks in this project. Tasks must reference an agent from this list.
        </p>
        {form.rosterAgents.length > 0 && (
          <ul className="space-y-1">
            {form.rosterAgents.map((agentName) => (
              <li key={agentName} className="flex items-center justify-between rounded border border-border bg-surface-raised px-3 py-1.5 text-sm">
                <span className="font-mono">{agentName}</span>
                <button
                  type="button"
                  onClick={() => form.setRosterAgents((prev) => prev.filter((n) => n !== agentName))}
                  className="text-text-dim hover:text-phase-failed transition-colors text-xs ml-4"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Select value={form.rosterPickerValue} onValueChange={(v) => {
            if (v && !form.rosterAgents.includes(v)) {
              form.setRosterAgents((prev) => [...prev, v]);
            }
            form.setRosterPickerValue("");
          }}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="— add agent —" />
            </SelectTrigger>
            <SelectContent>
              {clusterAgents
                .filter((a) => !form.rosterAgents.includes(a.name))
                .map((a) => (
                  <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </fieldset>
    </div>
  );
}

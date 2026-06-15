import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import type { ProjectFormHookReturn } from './useProjectForm';

interface WorkspaceServicesTabProps {
  form: Pick<
    ProjectFormHookReturn,
    | 'codeServerEnabled'
    | 'codeServerImage'
    | 'csCpuRequest'
    | 'csMemRequest'
    | 'csCpuLimit'
    | 'csMemLimit'
    | 'pvcName'
    | 'mountPath'
    | 'storageClass'
    | 'embeddingEnabled'
    | 'embeddingModel'
    | 'embeddingDimensions'
    | 'embeddingOllamaUrl'
    | 'execImage'
  > &
    Pick<
      ProjectFormHookReturn,
      | 'setCodeServerEnabled'
      | 'setCodeServerImage'
      | 'setCSCpuRequest'
      | 'setCSMemRequest'
      | 'setCSCpuLimit'
      | 'setCSMemLimit'
      | 'setPvcName'
      | 'setMountPath'
      | 'setStorageClass'
      | 'setEmbeddingEnabled'
      | 'setEmbeddingModel'
      | 'setEmbeddingDimensions'
      | 'setEmbeddingOllamaUrl'
      | 'setExecImage'
    >;
}

export default function WorkspaceServicesTab({ form }: WorkspaceServicesTabProps) {
  return (
    <div className="space-y-5">
      {/* Code Server */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Code Server</legend>
        <p className="text-xs text-text-dim">
          Enable interactive VS Code access to the workspace. Requires a data PVC (git or local
          source).
        </p>
        <Switch
          checked={form.codeServerEnabled}
          onCheckedChange={(v) => form.setCodeServerEnabled(v)}
        />

        {form.codeServerEnabled && (
          <>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-muted">Container Image</label>
              <Input
                type="text"
                value={form.codeServerImage}
                onChange={(e) => form.setCodeServerImage(e.target.value)}
                placeholder="codercom/code-server:4.96.4"
                className="font-mono"
              />
            </div>
            <div className="border-t border-border pt-3">
              <p className="text-xs font-medium mb-2 text-text-muted">Resource Requests</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-text-dim block">CPU (e.g. 100m)</label>
                  <Input
                    type="text"
                    value={form.csCpuRequest}
                    onChange={(e) => form.setCSCpuRequest(e.target.value)}
                    placeholder="100m"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-text-dim block">Memory (e.g. 256Mi)</label>
                  <Input
                    type="text"
                    value={form.csMemRequest}
                    onChange={(e) => form.setCSMemRequest(e.target.value)}
                    placeholder="256Mi"
                    className="font-mono"
                  />
                </div>
              </div>
            </div>
            <div className="border-t border-border pt-3">
              <p className="text-xs font-medium mb-2 text-text-muted">Resource Limits</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-text-dim block">CPU (e.g. 500m)</label>
                  <Input
                    type="text"
                    value={form.csCpuLimit}
                    onChange={(e) => form.setCSCpuLimit(e.target.value)}
                    placeholder="500m"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-text-dim block">Memory (e.g. 512Mi)</label>
                  <Input
                    type="text"
                    value={form.csMemLimit}
                    onChange={(e) => form.setCSMemLimit(e.target.value)}
                    placeholder="512Mi"
                    className="font-mono"
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </fieldset>

      {/* Data PVC */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Data PVC</legend>
        <p className="text-xs text-text-dim">
          Customize the persistent volume for workspace data. Leave blank to use defaults
          (&#123;project&#125;-data, mount path /data).
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">PVC Name</label>
            <Input
              type="text"
              value={form.pvcName}
              onChange={(e) => form.setPvcName(e.target.value)}
              placeholder="{project}-data"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Mount Path</label>
            <Input
              type="text"
              value={form.mountPath}
              onChange={(e) => form.setMountPath(e.target.value)}
              placeholder="/data"
              className="font-mono"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Storage Class</label>
          <Input
            type="text"
            value={form.storageClass}
            onChange={(e) => form.setStorageClass(e.target.value)}
            placeholder="(use cluster default)"
            className="font-mono"
          />
        </div>
      </fieldset>

      {/* Embedding / Memory service */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Memory / Embeddings</legend>
        <p className="text-xs text-text-dim">
          Enable the per-project vector memory service for agent context retrieval and semantic
          search across runs. Requires a data PVC and a running Ollama instance.
        </p>
        <Switch
          checked={form.embeddingEnabled}
          onCheckedChange={(v) => form.setEmbeddingEnabled(v)}
        />
        {form.embeddingEnabled && (
          <div className="ml-6 space-y-3 pt-1">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted">Embedding model</label>
              <Input
                type="text"
                value={form.embeddingModel}
                onChange={(e) => form.setEmbeddingModel(e.target.value)}
                placeholder="nomic-embed-text"
                className="font-mono"
              />
              <p className="text-xs text-text-dim">
                Ollama model name used for generating embeddings.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted">Vector dimensions</label>
              <Input
                type="number"
                min={64}
                max={4096}
                value={form.embeddingDimensions}
                onChange={(e) => form.setEmbeddingDimensions(e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-text-dim">
                Dimensionality of the embedding vectors (must match the model).
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted">Ollama URL</label>
              <Input
                type="text"
                value={form.embeddingOllamaUrl}
                onChange={(e) => form.setEmbeddingOllamaUrl(e.target.value)}
                placeholder="http://ollama:11434"
                className="font-mono"
              />
              <p className="text-xs text-text-dim">
                Overrides the cluster default Ollama service URL. Leave empty to use the built-in
                Ollama service.
              </p>
            </div>
          </div>
        )}
      </fieldset>

      {/* Exec / Maintenance Pod Image */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Exec / Maintenance Pod</legend>
        <p className="text-xs text-text-dim">
          Container image used for workspace exec pods (e.g. by the <code>exec_in_workspace</code>{' '}
          MCP tool). Leave blank to use the default fallback: <code>alpine/git:v2.54.0</code>
          (includes: git, git-lfs, openssh, gpg, ca-certificates).
        </p>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Container Image</label>
          <Input
            type="text"
            value={form.execImage}
            onChange={(e) => form.setExecImage(e.target.value)}
            placeholder="(use default: alpine/git:v2.54.0)"
            className="font-mono"
          />
        </div>
      </fieldset>
    </div>
  );
}

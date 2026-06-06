import type { ProjectFormHookReturn } from "./useProjectForm";

interface WorkspaceServicesTabProps {
  form: Pick<ProjectFormHookReturn, "codeServerEnabled" | "codeServerImage" | "csCpuRequest" | "csMemRequest" | "csCpuLimit" | "csMemLimit" | "pvcName" | "mountPath" | "storageClass" | "embeddingEnabled" | "embeddingModel" | "embeddingDimensions" | "embeddingOllamaUrl"> &
    Pick<ProjectFormHookReturn, "setCodeServerEnabled" | "setCodeServerImage" | "setCSCpuRequest" | "setCSMemRequest" | "setCSCpuLimit" | "setCSMemLimit" | "setPvcName" | "setMountPath" | "setStorageClass" | "setEmbeddingEnabled" | "setEmbeddingModel" | "setEmbeddingDimensions" | "setEmbeddingOllamaUrl">;
  inputClass: string;
  monoInputClass: string;
}

export default function WorkspaceServicesTab({ form, inputClass, monoInputClass }: WorkspaceServicesTabProps) {

  return (
    <div className="space-y-5">
      {/* Code Server */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-label-md">Code Server</legend>
        <p className="text-caption-xs text-text-dim">
          Enable interactive VS Code access to the workspace. Requires a data PVC (git or local source).
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.codeServerEnabled}
            onChange={(e) => form.setCodeServerEnabled(e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-body-sm text-text-muted">Enable code-server sidecar</span>
        </label>

        {form.codeServerEnabled && (
          <>
            <div className="space-y-1.5">
              <label className="text-label-md">Container Image</label>
              <input
                type="text"
                value={form.codeServerImage}
                onChange={(e) => form.setCodeServerImage(e.target.value)}
                placeholder="codercom/code-server:4.96.4"
                className={monoInputClass}
              />
            </div>
            <div className="border-t border-border pt-3">
              <p className="text-caption-xs font-medium mb-2 text-text-muted">Resource Requests</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-caption-xs text-text-dim block">CPU (e.g. 100m)</label>
                  <input
                    type="text"
                    value={form.csCpuRequest}
                    onChange={(e) => form.setCSCpuRequest(e.target.value)}
                    placeholder="100m"
                    className={monoInputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-caption-xs text-text-dim block">Memory (e.g. 256Mi)</label>
                  <input
                    type="text"
                    value={form.csMemRequest}
                    onChange={(e) => form.setCSMemRequest(e.target.value)}
                    placeholder="256Mi"
                    className={monoInputClass}
                  />
                </div>
              </div>
            </div>
            <div className="border-t border-border pt-3">
              <p className="text-caption-xs font-medium mb-2 text-text-muted">Resource Limits</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-caption-xs text-text-dim block">CPU (e.g. 500m)</label>
                  <input
                    type="text"
                    value={form.csCpuLimit}
                    onChange={(e) => form.setCSCpuLimit(e.target.value)}
                    placeholder="500m"
                    className={monoInputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-caption-xs text-text-dim block">Memory (e.g. 512Mi)</label>
                  <input
                    type="text"
                    value={form.csMemLimit}
                    onChange={(e) => form.setCSMemLimit(e.target.value)}
                    placeholder="512Mi"
                    className={monoInputClass}
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </fieldset>

      {/* Data PVC */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-label-md">Data PVC</legend>
        <p className="text-caption-xs text-text-dim">
          Customize the persistent volume for workspace data. Leave blank to use defaults (&#123;project&#125;-data, mount path /data).
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-label-md">PVC Name</label>
            <input
              type="text"
              value={form.pvcName}
              onChange={(e) => form.setPvcName(e.target.value)}
              placeholder="{project}-data"
              className={monoInputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-label-md">Mount Path</label>
            <input
              type="text"
              value={form.mountPath}
              onChange={(e) => form.setMountPath(e.target.value)}
              placeholder="/data"
              className={monoInputClass}
            />
          </div>
        </div>
        <div className="space-y-1.5">
            <label className="text-label-md">Storage Class</label>
          <input
            type="text"
            value={form.storageClass}
            onChange={(e) => form.setStorageClass(e.target.value)}
            placeholder="(use cluster default)"
            className={monoInputClass}
          />
        </div>
      </fieldset>

      {/* Embedding / Memory service */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-label-md">Memory / Embeddings</legend>
        <p className="text-caption-xs text-text-dim">
          Enable the per-project vector memory service for agent context retrieval
          and semantic search across runs. Requires a data PVC and a running Ollama instance.
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.embeddingEnabled}
            onChange={(e) => form.setEmbeddingEnabled(e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-body-sm text-text-muted">Enable memory service</span>
        </label>
        {form.embeddingEnabled && (
          <div className="ml-6 space-y-3 pt-1">
            <div className="space-y-1.5">
              <label className="text-label-md">Embedding model</label>
              <input
                type="text"
                value={form.embeddingModel}
                onChange={(e) => form.setEmbeddingModel(e.target.value)}
                placeholder="nomic-embed-text"
                className={monoInputClass}
              />
              <p className="text-caption-xs text-text-dim">Ollama model name used for generating embeddings.</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-label-md">Vector dimensions</label>
              <input
                type="number"
                min={64} max={4096}
                value={form.embeddingDimensions}
                onChange={(e) => form.setEmbeddingDimensions(e.target.value)}
                className={monoInputClass}
              />
              <p className="text-caption-xs text-text-dim">Dimensionality of the embedding vectors (must match the model).</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-label-md">Ollama URL</label>
              <input
                type="text"
                value={form.embeddingOllamaUrl}
                onChange={(e) => form.setEmbeddingOllamaUrl(e.target.value)}
                placeholder="http://ollama:11434"
                className={monoInputClass}
              />
              <p className="text-caption-xs text-text-dim">
                Overrides the cluster default Ollama service URL. Leave empty to use the built-in Ollama service.
              </p>
            </div>
          </div>
        )}
      </fieldset>
    </div>
  );
}

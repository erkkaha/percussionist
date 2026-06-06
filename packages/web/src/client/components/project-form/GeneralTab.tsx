import { Checkbox } from "../ui/checkbox";
import type { ProjectFormHookReturn } from "./useProjectForm";

interface GeneralTabProps {
  isEdit: boolean;
  form: Pick<ProjectFormHookReturn, "name" | "displayName" | "model" | "agent" | "maxParallel" | "timeoutSeconds" | "featureBranchingEnabled" | "phase"> &
    Pick<ProjectFormHookReturn, "setName" | "setDisplayName" | "setModel" | "setAgent" | "setMaxParallel" | "setTimeoutSeconds" | "setFeatureBranchingEnabled" | "setPhase">;
  inputClass: string;
  monoInputClass: string;
}

export default function GeneralTab({ form, isEdit, inputClass, monoInputClass }: GeneralTabProps) {

  return (
    <div className="space-y-5">
      {/* Name / Display */}
      {isEdit ? (
        <>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Name</label>
            <input
              type="text"
              value={form.name}
              readOnly
              className={monoInputClass + " opacity-70"}
            />
          </div>

          {/* Phase selector (edit mode only) */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Board Phase</label>
            <select
              value={form.phase}
              onChange={(e) => form.setPhase(e.target.value as "Active" | "Complete" | "Archived")}
              className={inputClass}
            >
              <option value="Active">Active</option>
              <option value="Complete">Complete</option>
              <option value="Archived">Archived</option>
            </select>
            <p className="text-xs text-text-dim">
              Controls whether the project board is active, completed, or archived.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Display Name</label>
            <input
              type="text"
              value={form.displayName}
              onChange={(e) => form.setDisplayName(e.target.value)}
              placeholder="My Repository"
              className={inputClass}
            />
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">
              Name <span className="text-phase-failed">*</span>
            </label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => form.setName(e.target.value)}
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
              value={form.displayName}
              onChange={(e) => form.setDisplayName(e.target.value)}
              placeholder="My Repository"
              className={inputClass}
            />
          </div>
        </div>
      )}

      {/* Model + Agent */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Default Model</label>
          <input
            type="text"
            value={form.model}
            onChange={(e) => form.setModel(e.target.value)}
            placeholder="anthropic/claude-sonnet-4-20250514"
            className={monoInputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Default Agent</label>
          <input
            type="text"
            value={form.agent}
            onChange={(e) => form.setAgent(e.target.value)}
            placeholder="build"
            className={inputClass}
          />
        </div>
      </div>

      {/* Max Parallel / Timeout / Feature Branching */}
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Max Parallel Tasks</label>
          <input
            type="number"
            min={1}
            value={form.maxParallel}
            onChange={(e) => form.setMaxParallel(e.target.value)}
            placeholder="2"
            className={monoInputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Timeout (seconds)</label>
          <input
            type="number"
            min={1}
            value={form.timeoutSeconds}
            onChange={(e) => form.setTimeoutSeconds(e.target.value)}
            placeholder="3600"
            className={monoInputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Feature Branching</label>
        <div className="flex items-center gap-2 h-9">
          <Checkbox
            checked={form.featureBranchingEnabled}
            onCheckedChange={(v) => form.setFeatureBranchingEnabled(v === true)}
          />
          <span className="text-sm text-text-muted">Enable per-task branches</span>
        </div>
        </div>
      </div>
    </div>
  );
}

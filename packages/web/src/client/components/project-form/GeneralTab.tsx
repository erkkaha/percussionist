import type { ProjectFormHookReturn } from "./useProjectForm";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

interface GeneralTabProps {
  isEdit: boolean;
  form: Pick<ProjectFormHookReturn, "name" | "displayName" | "model" | "agent" | "maxParallel" | "timeoutSeconds" | "featureBranchingEnabled" | "phase"> &
    Pick<ProjectFormHookReturn, "setName" | "setDisplayName" | "setModel" | "setAgent" | "setMaxParallel" | "setTimeoutSeconds" | "setFeatureBranchingEnabled" | "setPhase">;
}

export default function GeneralTab({ form, isEdit }: GeneralTabProps) {

  return (
    <div className="space-y-5">
      {/* Name / Display */}
      {isEdit ? (
        <>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Name</label>
            <Input
              type="text"
              value={form.name}
              readOnly
              className="font-mono opacity-70"
            />
          </div>

          {/* Phase selector (edit mode only) */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Board Phase</label>
            <Select value={form.phase} onValueChange={(v) => form.setPhase(v as "Active" | "Complete" | "Archived")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="Complete">Complete</SelectItem>
                <SelectItem value="Archived">Archived</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-text-dim">
              Controls whether the project board is active, completed, or archived.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Display Name</label>
            <Input
              type="text"
              value={form.displayName}
              onChange={(e) => form.setDisplayName(e.target.value)}
              placeholder="My Repository"
            />
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">
              Name <span className="text-phase-failed">*</span>
            </label>
            <Input
              type="text"
              required
              value={form.name}
              onChange={(e) => form.setName(e.target.value)}
              placeholder="my-repo"
              className="font-mono"
            />
            <p className="text-xs text-text-dim">
              Kubernetes resource name (lowercase, hyphens)
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Display Name</label>
            <Input
              type="text"
              value={form.displayName}
              onChange={(e) => form.setDisplayName(e.target.value)}
              placeholder="My Repository"
            />
          </div>
        </div>
      )}

      {/* Model + Agent */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Default Model</label>
          <Input
            type="text"
            value={form.model}
            onChange={(e) => form.setModel(e.target.value)}
            placeholder="anthropic/claude-sonnet-4-20250514"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Default Agent</label>
          <Input
            type="text"
            value={form.agent}
            onChange={(e) => form.setAgent(e.target.value)}
            placeholder="build"
          />
        </div>
      </div>

      {/* Max Parallel / Timeout / Feature Branching */}
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Max Parallel Tasks</label>
          <Input
            type="number"
            min={1}
            value={form.maxParallel}
            onChange={(e) => form.setMaxParallel(e.target.value)}
            placeholder="2"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Timeout (seconds)</label>
          <Input
            type="number"
            min={1}
            value={form.timeoutSeconds}
            onChange={(e) => form.setTimeoutSeconds(e.target.value)}
            placeholder="3600"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Feature Branching</label>
          <Switch
            checked={form.featureBranchingEnabled}
            onCheckedChange={(v) => form.setFeatureBranchingEnabled(v)}
          />
        </div>
      </div>
    </div>
  );
}

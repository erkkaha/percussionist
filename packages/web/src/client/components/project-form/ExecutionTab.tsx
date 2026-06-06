import type { ProjectFormHookReturn } from "./useProjectForm";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

interface ExecutionTabProps {
  form: Pick<ProjectFormHookReturn, "retryPolicyEnabled" | "retryPolicyMaxAttempts" | "retryPolicyBackoffSeconds" | "retryPolicyBackoffMultiplier" | "retryPolicyMaxBackoffSeconds" | "retryPolicyPoisonPillThreshold" | "reviewPolicyAiReviewerEnabled" | "reviewPolicyAiReviewerAgent" | "reviewPolicyMaxAutoReworks" | "runnerImage" | "cpuRequest" | "memRequest" | "cpuLimit" | "memLimit" | "worktreeReuse" | "flowPreset" | "flowHumanApprovalPlan" | "flowHumanApprovalBuild" | "flowPlanOnApprove" | "flowBuildOnSuccess" | "flowBuildOnApprove" | "flowMergeMode"> &
    Pick<ProjectFormHookReturn, "setRetryPolicyEnabled" | "setRetryPolicyMaxAttempts" | "setRetryPolicyBackoffSeconds" | "setRetryPolicyBackoffMultiplier" | "setRetryPolicyMaxBackoffSeconds" | "setRetryPolicyPoisonPillThreshold" | "setReviewPolicyAiReviewerEnabled" | "setReviewPolicyAiReviewerAgent" | "setReviewPolicyMaxAutoReworks" | "setRunnerImage" | "setCpuRequest" | "setMemRequest" | "setCpuLimit" | "setMemLimit" | "setWorktreeReuse" | "setFlowPreset" | "setFlowHumanApprovalPlan" | "setFlowHumanApprovalBuild" | "setFlowPlanOnApprove" | "setFlowBuildOnSuccess" | "setFlowBuildOnApprove" | "setFlowMergeMode">;
}

export default function ExecutionTab({ form }: ExecutionTabProps) {

  return (
    <div className="space-y-5">
      {/* Retry Policy */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Retry Policy</legend>
        <Switch
          checked={form.retryPolicyEnabled}
          onCheckedChange={(v) => form.setRetryPolicyEnabled(v)}
        />
        {form.retryPolicyEnabled && (
          <>
            <p className="text-xs text-text-dim">
              Retries use exponential backoff — each attempt waits longer than the last.
              If a retry finishes faster than the poison pill threshold, the task is considered stuck and retries stop.
            </p>
            <div className="grid grid-cols-3 gap-4 pt-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Max attempts</label>
                <Input
                  type="number"
                  min={1} max={10}
                  value={form.retryPolicyMaxAttempts}
                  onChange={(e) => form.setRetryPolicyMaxAttempts(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">Total retries before giving up.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Initial backoff (s)</label>
                <Input
                  type="number"
                  min={5} max={600}
                  value={form.retryPolicyBackoffSeconds}
                  onChange={(e) => form.setRetryPolicyBackoffSeconds(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">Delay before first retry.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Backoff multiplier</label>
                <Input
                  type="number"
                  min={1} max={5} step={0.1}
                  value={form.retryPolicyBackoffMultiplier}
                  onChange={(e) => form.setRetryPolicyBackoffMultiplier(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">Factor applied each retry (e.g. 2 → 30s, 60s, 120s).</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Max backoff (s)</label>
                <Input
                  type="number"
                  min={5} max={3600}
                  value={form.retryPolicyMaxBackoffSeconds}
                  onChange={(e) => form.setRetryPolicyMaxBackoffSeconds(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">Ceiling for backoff growth.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Poison pill threshold (s)</label>
                <Input
                  type="number"
                  min={5} max={300}
                  value={form.retryPolicyPoisonPillThreshold}
                  onChange={(e) => form.setRetryPolicyPoisonPillThreshold(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">Retries completing faster than this are treated as stuck.</p>
              </div>
            </div>
          </>
        )}
      </fieldset>

      {/* Review Policy */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Review Policy</legend>
        <Switch
          checked={form.reviewPolicyAiReviewerEnabled}
          onCheckedChange={(v) => form.setReviewPolicyAiReviewerEnabled(v)}
        />
        {form.reviewPolicyAiReviewerEnabled && (
          <>
            <p className="text-xs text-text-dim">
              When the reviewer rejects a task, it is sent back for rework automatically.
              After the max rework count is exceeded, it requires manual review.
            </p>
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Reviewer agent</label>
                <Input
                  type="text"
                  value={form.reviewPolicyAiReviewerAgent}
                  onChange={(e) => form.setReviewPolicyAiReviewerAgent(e.target.value)}
                  placeholder="reviewer"
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">ClusterAgent assigned to review completed tasks.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Max auto-reworks</label>
                <Input
                  type="number"
                  min={1} max={10}
                  value={form.reviewPolicyMaxAutoReworks}
                  onChange={(e) => form.setReviewPolicyMaxAutoReworks(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">Reworks exhausted → manual review required.</p>
              </div>
            </div>
          </>
        )}
      </fieldset>

      {/* Runner Overrides */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Runner Overrides</legend>
        <p className="text-xs text-text-dim">
          Override cluster-level runner defaults for this project.
        </p>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Runner Image</label>
          <Input
            type="text"
            value={form.runnerImage}
            onChange={(e) => form.setRunnerImage(e.target.value)}
            placeholder="percussionist/runner:dev"
            className="font-mono"
          />
        </div>
        <div className="border-t border-border pt-3">
          <p className="text-xs font-medium mb-2 text-text-muted">Resource Requests</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-text-dim block">CPU (e.g. 100m, 1)</label>
              <Input
                type="text"
                value={form.cpuRequest}
                onChange={(e) => form.setCpuRequest(e.target.value)}
                placeholder="100m"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-text-dim block">Memory (e.g. 128Mi)</label>
              <Input
                type="text"
                value={form.memRequest}
                onChange={(e) => form.setMemRequest(e.target.value)}
                placeholder="128Mi"
                className="font-mono"
              />
            </div>
          </div>
        </div>
        <div className="border-t border-border pt-3">
          <p className="text-xs font-medium mb-2 text-text-muted">Resource Limits</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-text-dim block">CPU (e.g. 500m, 1)</label>
              <Input
                type="text"
                value={form.cpuLimit}
                onChange={(e) => form.setCpuLimit(e.target.value)}
                placeholder="500m"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-text-dim block">Memory (e.g. 512Mi)</label>
              <Input
                type="text"
                value={form.memLimit}
                onChange={(e) => form.setMemLimit(e.target.value)}
                placeholder="512Mi"
                className="font-mono"
              />
            </div>
          </div>
        </div>
      </fieldset>

      {/* Git Cache */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Git Cache</legend>
        <p className="text-xs text-text-dim">
          Control how git worktrees are managed across runs.
        </p>
        <Switch
          checked={form.worktreeReuse}
          onCheckedChange={(v) => form.setWorktreeReuse(v)}
        />
        <p className="text-xs text-text-dim">
          When enabled, subsequent runs reuse the existing worktree instead of checking out fresh.
        </p>
      </fieldset>

      {/* Flow Configuration */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Task Lifecycle</legend>
        <p className="text-xs text-text-dim">
          Control how tasks flow through their lifecycle. Presets provide sensible defaults; overrides below customize specific steps.
        </p>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-muted">Preset</label>
          <Select value={form.flowPreset} onValueChange={(v) => form.setFlowPreset(v as typeof form.flowPreset)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="simple">Simple — no approvals, auto-done</SelectItem>
              <SelectItem value="review">Review — AI review on build success</SelectItem>
              <SelectItem value="plan-build">Plan → Build — plan generates builds, human approval</SelectItem>
              <SelectItem value="plan-build-review-merge">Plan → Build → Review → Merge (default)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {form.flowPreset !== "simple" && (
          <>
            <div className="border-t border-border pt-3 space-y-3">
              {/* Human Approval */}
              <div>
                <p className="text-xs font-medium mb-1.5 text-text-muted">Human Approval</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs text-text-dim block">Plan approval</label>
                    <Select value={form.flowHumanApprovalPlan} onValueChange={(v) => form.setFlowHumanApprovalPlan(v as "required" | "disabled")}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="required">Required</SelectItem>
                        <SelectItem value="disabled">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-text-dim block">Build approval</label>
                    <Select value={form.flowHumanApprovalBuild} onValueChange={(v) => form.setFlowHumanApprovalBuild(v as "required" | "disabled")}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="required">Required</SelectItem>
                        <SelectItem value="disabled">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Plan onApprove */}
              <div className="space-y-1.5">
                <label className="text-xs text-text-dim block">Plan approved →</label>
                <Select value={form.flowPlanOnApprove} onValueChange={(v) => form.setFlowPlanOnApprove(v as "generate-builds" | "done")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="generate-builds">Generate builds</SelectItem>
                    <SelectItem value="done">Mark done</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Build onSuccess */}
              <div className="space-y-1.5">
                <label className="text-xs text-text-dim block">Build succeeds →</label>
                <Select value={form.flowBuildOnSuccess} onValueChange={(v) => form.setFlowBuildOnSuccess(v as "human-review" | "ai-review" | "done")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="human-review">Human review</SelectItem>
                    <SelectItem value="ai-review">AI review</SelectItem>
                    <SelectItem value="done">Mark done</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Build onApprove */}
              <div className="space-y-1.5">
                <label className="text-xs text-text-dim block">Build approved →</label>
                <Select value={form.flowBuildOnApprove} onValueChange={(v) => form.setFlowBuildOnApprove(v as "merge" | "done")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="merge">Merge to parent branch</SelectItem>
                    <SelectItem value="done">Mark done (no merge)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Merge mode */}
              <div className="space-y-1.5">
                <label className="text-xs text-text-dim block">Merge mode</label>
                <Select value={form.flowMergeMode} onValueChange={(v) => form.setFlowMergeMode(v as "auto" | "manual" | "disabled")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-merge on approval</SelectItem>
                    <SelectItem value="manual">Manual merge required</SelectItem>
                    <SelectItem value="disabled">No merging</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </>
        )}
      </fieldset>
    </div>
  );
}

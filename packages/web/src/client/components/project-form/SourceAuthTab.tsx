import { Link } from "react-router-dom";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { ProjectFormHookReturn } from "./useProjectForm";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";

interface SourceAuthTabProps {
  form: Pick<ProjectFormHookReturn, "gitUrl" | "gitRef" | "gitSshSecret" | "gitGithubTokenSecret" | "gitAuthorName" | "gitAuthorEmail" | "sourceLocal" | "llmKeysSecret" | "authSecret" | "opencodeConfig" | "configJsonError"> &
    Pick<ProjectFormHookReturn, "setGitUrl" | "setGitRef" | "setGitSshSecret" | "setGitGithubTokenSecret" | "setGitAuthorName" | "setGitAuthorEmail" | "setSourceLocal" | "setLlmKeysSecret" | "setAuthSecret" | "setOpencodeConfig">;
}

export default function SourceAuthTab({ form }: SourceAuthTabProps) {

  return (
    <div className="space-y-5">
      {/* Git source */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Git source</legend>

        {/* Local workspace toggle */}
        <Switch
          checked={form.sourceLocal}
          onCheckedChange={(v) => form.setSourceLocal(v)}
        />
        {form.sourceLocal && (
          <p className="text-xs text-text-dim">
            Local workspace — no remote repository will be cloned. Changes persist across runs at /data/workspace/.
          </p>
        )}

        {!form.sourceLocal && (
          <>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-muted">Repository URL</label>
              <Input
                type="text"
                value={form.gitUrl}
                onChange={(e) => form.setGitUrl(e.target.value)}
                placeholder="git@github.com:org/repo.git"
                className="font-mono"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-muted">
                  Ref <span className="text-text-dim font-normal">(branch / tag / SHA)</span>
                </label>
                <Input
                  type="text"
                  value={form.gitRef}
                  onChange={(e) => form.setGitRef(e.target.value)}
                  placeholder="main"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-muted">SSH Secret</label>
                <Input
                  type="text"
                  value={form.gitSshSecret}
                  onChange={(e) => form.setGitSshSecret(e.target.value)}
                  placeholder="git-ssh-key"
                  className="font-mono"
                />
                <p className="text-xs text-text-dim">
                  Secret name from{" "}
                  <code className="font-mono">beatctl ssh-key create</code>
                </p>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-muted">GitHub Token Secret</label>
              <Input
                type="text"
                value={form.gitGithubTokenSecret}
                onChange={(e) => form.setGitGithubTokenSecret(e.target.value)}
                placeholder="git-github-token"
                className="font-mono"
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
                <Input
                  type="text"
                  value={form.gitAuthorName}
                  onChange={(e) => form.setGitAuthorName(e.target.value)}
                  placeholder="Percussionist Agent"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-muted">Author email</label>
                <Input
                  type="email"
                  value={form.gitAuthorEmail}
                  onChange={(e) => form.setGitAuthorEmail(e.target.value)}
                  placeholder="agent@example.com"
                  className="font-mono"
                />
              </div>
            </div>
          </>
        )}
      </fieldset>

      {/* Secrets */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Secrets</legend>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">LLM Keys Secret</label>
            <Input
              type="text"
              value={form.llmKeysSecret}
              onChange={(e) => form.setLlmKeysSecret(e.target.value)}
              placeholder="llm-keys"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Auth Secret</label>
            <Input
              type="text"
              value={form.authSecret}
              onChange={(e) => form.setAuthSecret(e.target.value)}
              placeholder="opencode-auth"
              className="font-mono"
            />
          </div>
        </div>
      </fieldset>

      {/* OpenCode Config */}
      <fieldset className="rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">OpenCode config</legend>
        <p className="text-xs text-text-dim mb-2">
          Configure OpenCode at the project level. To set cluster-wide OpenCode config, use{" "}
          <Link to="/settings" className="underline hover:text-text">Settings</Link>.
        </p>
        <Textarea
          value={form.opencodeConfig ?? ""}
          onChange={(e) => form.setOpencodeConfig(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={'{\n  "providers": [...],\n  "mcp": {...}\n}'}
          className="font-mono text-xs leading-5"
        />
        {form.configJsonError && (
          <p className="text-xs text-phase-failed mt-1">Invalid JSON: {form.configJsonError}</p>
        )}
      </fieldset>
    </div>
  );
}

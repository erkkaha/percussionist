import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSettings,
  saveSettings,
  fetchOpencodeConfig,
  listSecrets,
  createSecret,
  updateSecret,
  deleteSecret,
  fetchUpdateStatus,
  postUpgradeApply,
  type UpdateStatus,
  type UpgradeResult,
} from "../lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./ui/card";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { RefreshCw, Loader2 } from "lucide-react";
import ModelSelector from "./ModelSelector";
import ProjectsPage from "./ProjectsPage";
import AgentsPage from "./AgentsPage";

type Tab = "projects" | "agents" | "secrets" | "opencode" | "manager" | "runner" | "updates";
type SettingsSpec = Record<string, unknown> & {
  runnerConfig?: Record<string, unknown>;
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get("tab") as Tab | null) ?? "projects";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });

  const { data: opencodeConfig, isLoading: configLoading } = useQuery({
    queryKey: ["opencode-config"],
    queryFn: fetchOpencodeConfig,
  });

  const { data: secretsList } = useQuery({
    queryKey: ["settings-secrets"],
    queryFn: listSecrets,
  });

  const saveMutation = useMutation({
    mutationFn: (spec: Record<string, unknown>) => saveSettings(spec),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setSaveMsg("Settings saved.");
      setTimeout(() => setSaveMsg(null), 3000);
    },
    onError: (e: unknown) => {
      setSaveMsg(`Error: ${(e as Error).message}`);
    },
  });

  const secretMutation = useMutation({
    mutationFn: (payload: { name: string; data: Record<string, string>; op: "create" | "update" | "delete" }) => {
      if (payload.op === "delete") return deleteSecret(payload.name);
      if (payload.op === "create") return createSecret(payload.name, payload.data);
      return updateSecret(payload.name, payload.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings-secrets"] });
      setSaveMsg("Secret updated.");
      setTimeout(() => setSaveMsg(null), 3000);
    },
    onError: (e: unknown) => {
      setSaveMsg(`Error: ${(e as Error).message}`);
    },
  });

  const spec = (settings?.spec ?? {}) as SettingsSpec;
  const { data: updateStatus } = useQuery<UpdateStatus>({
    queryKey: ["update-status"],
    queryFn: fetchUpdateStatus,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const tabs: { id: Tab; label: string }[] = [
    { id: "projects", label: "Projects" },
    { id: "agents", label: "Agents" },
    { id: "secrets", label: "Provider Secrets" },
    { id: "opencode", label: "OpenCode Config" },
    { id: "manager", label: "Manager Agent" },
    { id: "runner", label: "Runner Defaults" },
    { id: "updates", label: "Updates" },
  ];

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex items-center justify-between settings-header-mobile">
        <h1 className="text-xl font-semibold text-lg sm:text-xl">Settings</h1>
        {saveMsg && (
          <span className={cn(
            "text-sm",
            saveMsg.startsWith("Error") ? "text-red-500" : "text-green-500"
          )}>{saveMsg}</span>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border settings-tabs-wrap overflow-x-auto sm:overflow-visible">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors",
              "border-b-2 -mb-px",
              activeTab === t.id
                ? "border-accent text-accent"
                : "border-transparent text-text-dim hover:text-text"
            )}
          >
            <span className="relative">
              {t.label}
              {t.id === "updates" && updateStatus?.updateAvailable && (
                <span className="absolute -top-0.5 -right-2.5 w-2 h-2 rounded-full bg-amber-400" />
              )}
            </span>
          </button>
        ))}
      </div>

      {activeTab === "projects" && <ProjectsPage />}

      {activeTab === "agents" && <AgentsPage />}

      {settingsLoading && activeTab !== "projects" && activeTab !== "agents" && (
        <p className="text-text-dim">Loading...</p>
      )}

      {!settingsLoading && activeTab === "secrets" && (
        <SecretsPanel
          spec={spec}
          secretsList={secretsList?.items ?? []}
          onSave={(newSpec) => saveMutation.mutate(newSpec)}
          onSecretOp={(name, data, op) => secretMutation.mutate({ name, data, op })}
          saving={saveMutation.isPending}
        />
      )}

      {!settingsLoading && activeTab === "opencode" && (
        <OpencodePanel
          config={(opencodeConfig as string) ?? ""}
          onSave={(config) => saveMutation.mutate({ 
            ...spec, 
            runnerConfig: { 
              ...(spec.runnerConfig as Record<string, unknown> | undefined), 
              config 
            } 
          })}
          saving={saveMutation.isPending}
        />
      )}

      {!settingsLoading && activeTab === "manager" && (
        <ManagerPanel
          spec={spec}
          onSave={(newSpec) => saveMutation.mutate(newSpec)}
          saving={saveMutation.isPending}
        />
      )}

      {!settingsLoading && activeTab === "runner" && (
        <RunnerPanel
          spec={spec}
          onSave={(newSpec) => saveMutation.mutate(newSpec)}
          saving={saveMutation.isPending}
        />
      )}

      {activeTab === "updates" && <UpdatesPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secrets panel

interface SecretsPanelProps {
  spec: Record<string, unknown>;
  secretsList: Array<{ name: string; keys: string[] }>;
  onSave: (spec: Record<string, unknown>) => void;
  onSecretOp: (name: string, data: Record<string, string>, op: "create" | "update" | "delete") => void;
  saving: boolean;
}

function SecretsPanel({ spec, secretsList, onSave, onSecretOp, saving }: SecretsPanelProps) {
  const [llmKeysSecret, setLlmKeysSecret] = useState(
    (spec.secrets as Record<string, unknown> | undefined)?.llmKeysSecret as string ?? "llm-keys"
  );
  const authSecretObj = (spec.secrets as Record<string, unknown> | undefined)?.authSecret as { name?: string } | undefined;
  const [authSecretName, setAuthSecretName] = useState(authSecretObj?.name ?? "");
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Pre-populate from cluster config
  const llmSecretData: Record<string, string> = {};
  const authSecretData: Record<string, string> = {};

  const existingLlmSecret = secretsList.find((s) => s.name === llmKeysSecret);
  const existingAuthSecret = secretsList.find((s) => s.name === authSecretName);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider API Keys</CardTitle>
        <CardDescription>
          Store LLM provider API keys as a Kubernetes Secret. All keys are injected as
          environment variables into every run pod (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium block mb-1">LLM Keys Secret Name</label>
          <div className="flex gap-2 flex-wrap">
            <Input
              value={llmKeysSecret}
              onChange={(e) => setLlmKeysSecret(e.target.value)}
              placeholder="llm-keys"
              className="flex-1 min-w-0 sm:w-64"
            />
            <Button
              variant="outline"
              onClick={() =>
                onSecretOp(llmKeysSecret, llmSecretData, existingLlmSecret ? "update" : "create")
              }
              disabled={saving || !llmKeysSecret.trim()}
            >
              {existingLlmSecret ? "Update Secret" : "Create Secret"}
            </Button>
          </div>
          {existingLlmSecret && (
            <p className="text-xs text-text-dim mt-1">
              Existing secret. Keys: {existingLlmSecret.keys.join(", ") || "(empty)"}
            </p>
          )}
        </div>

        <div className="border-t border-border pt-4">
          <label className="text-sm font-medium block mb-1">OpenCode Auth Secret Name</label>
          <div className="flex gap-2 flex-wrap">
            <Input
              value={authSecretName}
              onChange={(e) => setAuthSecretName(e.target.value)}
              placeholder="percussionist-auth"
              className="flex-1 min-w-0 sm:w-64"
            />
            <Button
              variant="outline"
              onClick={() =>
                onSecretOp(authSecretName, authSecretData, existingAuthSecret ? "update" : "create")
              }
              disabled={saving || !authSecretName.trim()}
            >
              {existingAuthSecret ? "Update Secret" : "Create Secret"}
            </Button>
          </div>
          {existingAuthSecret && (
            <p className="text-xs text-text-dim mt-1">
              Existing secret. Keys: {existingAuthSecret.keys.join(", ") || "(empty)"}
            </p>
          )}
        </div>
      </CardContent>
      <CardFooter className="sm:flex-row flex-col gap-2">
        <Button
          onClick={() =>
            onSave({ ...spec, secrets: { llmKeysSecret: llmKeysSecret.trim() || undefined, authSecret: authSecretName.trim() ? { name: authSecretName.trim(), key: "auth.json" } : undefined } })
          }
          disabled={saving}
          className="w-full sm:w-auto"
        >
          Save Secrets Reference
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// OpenCode Config panel

interface OpencodePanelProps {
  config: string;
  onSave: (config: string) => void;
  saving: boolean;
}

function OpencodePanel({ config, onSave, saving }: OpencodePanelProps) {
  const [value, setValue] = useState(config);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Keep value in sync when config loads from query
  if (config !== value && value === config) {
    // already in sync
  }

  function handleChange(raw: string) {
    setValue(raw);
    try {
      JSON.parse(raw);
      setJsonError(null);
    } catch {
      setJsonError("Invalid JSON — check your syntax.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>OpenCode Configuration</CardTitle>
        <CardDescription>
          Raw <code className="font-mono text-xs">opencode.json</code> content applied
          cluster-wide. Stored in the <code className="font-mono text-xs">opencode-config</code>{" "}
          ConfigMap by the operator. Supports providers, MCP servers, skills, and all other
          opencode settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <textarea
          className="w-full h-64 sm:h-80 font-mono text-sm border border-input bg-background rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          spellCheck={false}
          placeholder={'{\n  "providers": [...],\n  "mcp": {...}\n}'}
        />
        {jsonError && <p className="text-xs text-red-500 mt-1">{jsonError}</p>}
        {!jsonError && value.trim() && (
          <p className="text-xs text-green-500 mt-1">Valid JSON</p>
        )}
      </CardContent>
      <CardFooter className="sm:flex-row flex-col gap-2">
        <Button onClick={() => onSave(value)} disabled={saving || !!jsonError} className="w-full sm:w-auto">
          Save OpenCode Config
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Manager Agent panel

interface ManagerPanelProps {
  spec: Record<string, unknown>;
  onSave: (spec: Record<string, unknown>) => void;
  saving: boolean;
}

function ManagerPanel({ spec, onSave, saving }: ManagerPanelProps) {
  const manager = (spec.manager as Record<string, unknown> | undefined) ?? {};
  const [agentName, setAgentName] = useState((manager.agentName as string) ?? "manager-agent");
  const [decisionAgentName, setDecisionAgentName] = useState((manager.decisionAgentName as string) ?? "manager-decision");
  const [model, setModel] = useState((manager.model as string) ?? "");
  const [timeoutSec, setTimeoutSec] = useState(String(Math.round(((manager.timeoutMs as number) ?? 30000) / 1000)));
  const [firstResponseTimeoutSec, setFirstResponseTimeoutSec] = useState(
    (manager.firstResponseTimeoutMs as number | undefined) != null
      ? String(Math.round((manager.firstResponseTimeoutMs as number) / 1000))
      : ""
  );
  const [decisionAgentContent, setDecisionAgentContent] = useState(
    (manager.decisionAgentContent as string) ?? ""
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manager Agent</CardTitle>
        <CardDescription>
          Configuration for the manager's embedded agent that drives the kanban board,
          facilitates failures, and provides interactive chat.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium block mb-1">Agent Name</label>
            <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Decision Agent Name</label>
            <Input value={decisionAgentName} onChange={(e) => setDecisionAgentName(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium block mb-1">Model</label>
            <ModelSelector
              value={model}
              onChange={setModel}
              placeholder="e.g. anthropic/claude-sonnet-4-20250514"
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Timeout (seconds)</label>
            <Input
              type="number"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(e.target.value)}
              min={1}
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">First Response Timeout (seconds) <span className="text-text-dim font-normal">— empty = default (min of overall timeout, 60s)</span></label>
          <Input
            type="number"
            value={firstResponseTimeoutSec}
            onChange={(e) => setFirstResponseTimeoutSec(e.target.value)}
            min={1}
            placeholder="default"
          />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">Decision Agent Content (.md)</label>
          <textarea
            className="w-full h-48 font-mono text-sm border border-input bg-background rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            value={decisionAgentContent}
            onChange={(e) => setDecisionAgentContent(e.target.value)}
            placeholder={"---\ndescription: ...\nmode: subagent\npermission:\n  edit: allow\n  bash: allow\n---\n\nYou are the decision-making agent..."}
            spellCheck={false}
          />
        </div>
      </CardContent>
      <CardFooter className="sm:flex-row flex-col gap-2">
        <Button
          onClick={() => {
            const timeoutMsVal = parseInt(timeoutSec, 10) * 1000;
            const frtVal = firstResponseTimeoutSec.trim()
              ? parseInt(firstResponseTimeoutSec, 10) * 1000
              : undefined;
            onSave({
              ...spec,
              manager: {
                agentName: agentName.trim() || undefined,
                decisionAgentName: decisionAgentName.trim() || undefined,
                model: model.trim() || undefined,
                timeoutMs: timeoutMsVal || undefined,
                firstResponseTimeoutMs: frtVal || undefined,
                decisionAgentContent: decisionAgentContent.trim() || undefined,
              },
            })
          }}
          disabled={saving}
          className="w-full sm:w-auto"
        >
          Save Manager Settings
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Runner Defaults panel

interface RunnerPanelProps {
  spec: Record<string, unknown>;
  onSave: (spec: Record<string, unknown>) => void;
  saving: boolean;
}

function RunnerPanel({ spec, onSave, saving }: RunnerPanelProps) {
  const runner = (spec.runner as Record<string, unknown> | undefined) ?? {};
  const [image, setImage] = useState((runner.image as string) ?? "percussionist/runner:dev");
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    String((runner.timeoutSeconds as number) ?? 3600)
  );
  const [cpuRequest, setCpuRequest] = useState(
    ((runner.resources as Record<string, Record<string, string>> | undefined)?.requests?.cpu) ?? ""
  );
  const [memRequest, setMemRequest] = useState(
    ((runner.resources as Record<string, Record<string, string>> | undefined)?.requests?.memory) ?? ""
  );
  const [cpuLimit, setCpuLimit] = useState(
    ((runner.resources as Record<string, Record<string, string>> | undefined)?.limits?.cpu) ?? ""
  );
  const [memLimit, setMemLimit] = useState(
    ((runner.resources as Record<string, Record<string, string>> | undefined)?.limits?.memory) ?? ""
  );
  const [runTTLDays, setRunTTLDays] = useState(
    String((spec.runTTLDays as number) ?? 7)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runner Defaults</CardTitle>
        <CardDescription>
          Default pod settings applied to all runs unless overridden at the project or board level.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium block mb-1">Runner Image</label>
            <Input value={image} onChange={(e) => setImage(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Timeout (seconds)</label>
            <Input
              type="number"
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              min={60}
            />
          </div>
        </div>
        <div className="border-t border-border pt-4">
          <p className="text-sm font-medium mb-2">Resource Requests</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-text-dim block mb-1">CPU request (e.g. 100m, 1)</label>
              <Input value={cpuRequest} onChange={(e) => setCpuRequest(e.target.value)} placeholder="100m" />
            </div>
            <div>
              <label className="text-xs text-text-dim block mb-1">Memory request (e.g. 128Mi)</label>
              <Input value={memRequest} onChange={(e) => setMemRequest(e.target.value)} placeholder="128Mi" />
            </div>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium mb-2">Resource Limits</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-text-dim block mb-1">CPU limit (e.g. 500m, 1)</label>
              <Input value={cpuLimit} onChange={(e) => setCpuLimit(e.target.value)} placeholder="500m" />
            </div>
            <div>
              <label className="text-xs text-text-dim block mb-1">Memory limit (e.g. 512Mi)</label>
              <Input value={memLimit} onChange={(e) => setMemLimit(e.target.value)} placeholder="512Mi" />
            </div>
          </div>
        </div>
        <div className="border-t border-border pt-4">
          <p className="text-sm font-medium mb-2">Cleanup</p>
          <div>
            <label className="text-xs text-text-dim block mb-1">Run TTL (days)</label>
            <Input
              type="number"
              min={1}
              value={runTTLDays}
              onChange={(e) => setRunTTLDays(e.target.value)}
            />
            <p className="text-xs text-text-dim mt-1">
              Completed Run CRs are automatically cleaned up after this many days.
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="sm:flex-row flex-col gap-2">
        <Button
          onClick={() => {
            const resources: Record<string, { cpu?: string; memory?: string }> = {};
            if (cpuRequest || memRequest) {
              resources.requests = {};
              if (cpuRequest) resources.requests.cpu = cpuRequest;
              if (memRequest) resources.requests.memory = memRequest;
            }
            if (cpuLimit || memLimit) {
              resources.limits = {};
              if (cpuLimit) resources.limits.cpu = cpuLimit;
              if (memLimit) resources.limits.memory = memLimit;
            }
            onSave({
              ...spec,
              runTTLDays: parseInt(runTTLDays, 10) || 7,
              runner: {
                image: image.trim() || undefined,
                timeoutSeconds: parseInt(timeoutSeconds, 10) || undefined,
                ...(Object.keys(resources).length > 0 ? { resources } : {}),
              },
            });
          }}
          disabled={saving}
          className="w-full sm:w-auto"
        >
          Save Runner Defaults
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Updates panel

function UpdatesPanel() {
  const upgradeMutation = useMutation<UpgradeResult, Error, string>({
    mutationFn: postUpgradeApply,
  });

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<UpdateStatus>({
    queryKey: ["update-status"],
    queryFn: fetchUpdateStatus,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    // Poll every 5s while an upgrade is in flight so the banner clears automatically.
    refetchInterval: (query) => {
      if (!upgradeMutation.isSuccess) return false;
      const target = upgradeMutation.data.targetTag;
      const cur = query.state.data?.current;
      const done = [cur?.operator, cur?.manager, cur?.web].filter(Boolean).every((v) => v === target);
      return done ? false : 5_000;
    },
  });

  // Hide the success banner once the running versions have caught up to the target tag.
  const upgradeComplete = upgradeMutation.isSuccess && (() => {
    const target = upgradeMutation.data.targetTag;
    const { operator, manager, web } = data?.current ?? {};
    return [operator, manager, web].filter(Boolean).every((v) => v === target);
  })();

  const currentTag =
    data?.current?.operator ??
    data?.current?.manager ??
    data?.current?.web ??
    null;

  // Derive GitHub release URL from registryPrefix if available
  // e.g. "ghcr.io/erkkaha/percussionist" → "https://github.com/erkkaha/percussionist"
  const releaseUrl = (() => {
    const prefix = data?.registryPrefix ?? "";
    const parts = prefix.replace(/^[^/]+\//, ""); // strip registry host
    if (!parts || !data?.latest) return null;
    return `https://github.com/${parts}/releases/tag/${data.latest}`;
  })();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>Updates</CardTitle>
            <CardDescription>
              Current running versions and latest available release from the container registry.
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void refetch()}
            disabled={isFetching || upgradeMutation.isPending}
            className="shrink-0 mt-0.5"
            title="Check for updates"
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading && (
          <p className="text-text-dim text-sm">Checking for updates...</p>
        )}

        {isError && !upgradeMutation.isPending && !upgradeMutation.isSuccess && (
          <p className="text-red-500 text-sm">
            Could not check for updates: {(error as Error).message}
          </p>
        )}

        {data?.error && !upgradeMutation.isPending && (
          <p className="text-amber-500 text-sm">
            Registry check failed: {data.error}
          </p>
        )}

        {upgradeMutation.isError && (
          <p className="text-red-500 text-sm">
            Upgrade failed: {upgradeMutation.error.message}
          </p>
        )}

        {(upgradeMutation.isPending || (upgradeMutation.isSuccess && !upgradeComplete)) && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm text-text-dim">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              <span>Installing update — deployments are rolling out…</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-surface-raised overflow-hidden">
              <div className="h-full bg-accent rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite]" style={{ width: "40%" }} />
            </div>
          </div>
        )}

        {data && (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium mb-1">Running versions</p>
              {(
                [
                  ["operator", data.current.operator],
                  ["manager", data.current.manager],
                  ["web", data.current.web],
                ] as [string, string | null][]
              ).map(([name, tag]) => (
                <div key={name} className="flex items-center gap-2 text-sm">
                  <span className="text-text-dim w-20">{name}</span>
                  <span className="font-mono">{tag ?? <span className="text-text-dim italic">unknown</span>}</span>
                </div>
              ))}
            </div>

            <div className="border-t border-border pt-4">
              {data.updateAvailable && data.latest ? (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                    <p className="text-sm font-medium">
                      Version <span className="font-mono">{data.latest}</span> is available
                      {currentTag && (
                        <span className="text-text-dim font-normal">
                          {" "}(running <span className="font-mono">{currentTag}</span>)
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4 mt-1">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => upgradeMutation.mutate(data.latest!)}
                      disabled={upgradeMutation.isPending}
                    >
                      {upgradeMutation.isPending ? "Upgrading..." : "Upgrade"}
                    </Button>
                    {releaseUrl && (
                      <a
                        href={releaseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent underline underline-offset-2"
                      >
                        View release notes
                      </a>
                    )}
                  </div>
                </div>
              ) : data.latest && !data.error ? (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-phase-succeeded shrink-0" />
                  <p className="text-sm">
                    Up to date{" "}
                    <span className="text-text-dim font-normal">
                      (<span className="font-mono">{data.latest}</span>)
                    </span>
                  </p>
                </div>
              ) : !data.error ? (
                <p className="text-text-dim text-sm">Latest version unavailable</p>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

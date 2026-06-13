import { useState } from "react";
import type { ProjectDetail, CreateProjectRequest } from "../../lib/types";

// ---------------------------------------------------------------------------
// Row types (local-only keys)
// ---------------------------------------------------------------------------

export interface SidecarRow {
  id: number;
  name: string;
  image: string;
  ports: string; // comma-separated numbers
  env: string;   // newline-separated KEY=VALUE pairs
}

export interface InjectFileRow {
  id: number;
  filename: string;
  content: string;
}

// ---------------------------------------------------------------------------
// ID sequences (module-level, stable across renders)
// ---------------------------------------------------------------------------

let _sidecarIdSeq = 0;
function nextSidecarId() { return ++_sidecarIdSeq; }

let _injectFileIdSeq = 0;
function nextInjectFileId() { return ++_injectFileIdSeq; }

// ---------------------------------------------------------------------------
// Initializers
// ---------------------------------------------------------------------------

export function initialInjectFileRows(project: ProjectDetail | undefined): InjectFileRow[] {
  const contents = project?.injectFileContents ?? [];
  return contents.map((f) => ({
    id: nextInjectFileId(),
    filename: f.filename,
    content: f.content,
  }));
}

export function initialSidecarRows(spec: ProjectDetail["spec"] | undefined): SidecarRow[] {
  if (!spec?.sidecars?.length) return [];
  return spec.sidecars.map((sc) => ({
    id: nextSidecarId(),
    name: sc.name,
    image: sc.image,
    ports: (sc.ports ?? []).join(", "),
    env: (sc.env ?? []).map((e: { name: string; value: string }) => `${e.name}=${e.value}`).join("\n"),
  }));
}

// ---------------------------------------------------------------------------
// Form state interface — all fields needed by every tab
// ---------------------------------------------------------------------------

export interface ProjectFormState {
  // General
  name: string;
  displayName: string;
  model: string;
  agent: string;
  maxParallel: string;
  timeoutSeconds: string;
  featureBranchingEnabled: boolean;
  phase: "Active" | "Complete" | "Archived";

  // Source & Auth
  gitUrl: string;
  gitRef: string;
  gitSshSecret: string;
  gitGithubTokenSecret: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  sourceLocal: boolean;
  llmKeysSecret: string;
  authSecret: string;
  opencodeConfig: string;

  // Execution
  retryPolicyEnabled: boolean;
  retryPolicyMaxAttempts: string;
  retryPolicyBackoffSeconds: string;
  retryPolicyBackoffMultiplier: string;
  retryPolicyMaxBackoffSeconds: string;
  retryPolicyPoisonPillThreshold: string;
  reviewPolicyAiReviewerEnabled: boolean;
  reviewPolicyAiReviewerAgent: string;
  reviewPolicyMaxAutoReworks: string;
  runnerImage: string;
  cpuRequest: string;
  memRequest: string;
  cpuLimit: string;
  memLimit: string;
  worktreeReuse: boolean;
  flowPreset: "simple" | "review" | "plan-build" | "plan-build-review-merge";
  flowHumanApprovalPlan: "required" | "disabled";
  flowHumanApprovalBuild: "required" | "disabled";
  flowPlanOnApprove: "generate-builds" | "done";
  flowBuildOnSuccess: "human-review" | "ai-review" | "done";
  flowBuildOnApprove: "merge" | "done";
  flowMergeMode: "auto" | "manual" | "disabled";

  // Workspace & Services
  codeServerEnabled: boolean;
  codeServerImage: string;
  csCpuRequest: string;
  csMemRequest: string;
  csCpuLimit: string;
  csMemLimit: string;
  pvcName: string;
  mountPath: string;
  storageClass: string;
  embeddingEnabled: boolean;
  embeddingModel: string;
  embeddingDimensions: string;
  embeddingOllamaUrl: string;

  /** Exec/maintenance pod configuration — controls the container image used for workspace exec pods. */
  execImage: string;

  // Advanced
  sidecars: SidecarRow[];
  injectFiles: InjectFileRow[];
  initScript: string;
  rosterAgents: string[];
  rosterPickerValue: string;
}

// ---------------------------------------------------------------------------
// Validation helpers (derived, not state)
// ---------------------------------------------------------------------------

export function computeSidecarErrors(sidecars: SidecarRow[]): Record<number, string> {
  const errors: Record<number, string> = {};
  for (const sc of sidecars) {
    if (!sc.name.trim()) { errors[sc.id] = "Name is required"; continue; }
    if (!sc.image.trim()) { errors[sc.id] = "Image is required"; continue; }
    if (sc.ports.trim()) {
      const bad = sc.ports.split(",").map((p) => p.trim()).filter(Boolean).find((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535);
      if (bad) { errors[sc.id] = `Invalid port: ${bad}`; continue; }
    }
  }
  return errors;
}

export function computeInjectFileErrors(injectFiles: InjectFileRow[]): Record<number, string> {
  const errors: Record<number, string> = {};
  for (const f of injectFiles) {
    if (!f.filename.trim()) { errors[f.id] = "Filename is required"; continue; }
    if (f.filename.includes("/") || f.filename.includes("\\")) { errors[f.id] = "Filename must not contain path separators"; continue; }
  }
  return errors;
}

export function computeConfigJsonError(opencodeConfig: string): string | null {
  if (!opencodeConfig?.trim()) return null;
  try { JSON.parse(opencodeConfig); return null; }
  catch (e) { return (e as Error).message; }
}

// ---------------------------------------------------------------------------
// Request builder — form state → CreateProjectRequest
// ---------------------------------------------------------------------------

export function buildProjectRequest(
  state: ProjectFormState,
  isEdit: boolean,
): CreateProjectRequest {
  const req: CreateProjectRequest = {};
  if (!isEdit && state.name.trim()) req.name = state.name.trim();
  if (state.displayName.trim()) req.displayName = state.displayName.trim();
  if (state.model.trim()) req.model = state.model.trim();
  if (state.agent.trim()) req.agent = state.agent.trim();
  if (state.opencodeConfig !== null) req.opencodeConfig = state.opencodeConfig.trim() || "";

  // Source
  if (state.sourceLocal) {
    req.source = { local: true };
  } else if (state.gitUrl.trim()) {
    req.source = {
      git: {
        url: state.gitUrl.trim(),
        ...(state.gitRef.trim() ? { ref: state.gitRef.trim() } : {}),
        ...(state.gitSshSecret.trim()
          ? { sshSecret: { name: state.gitSshSecret.trim() } }
          : {}),
        ...(state.gitGithubTokenSecret.trim()
          ? { githubTokenSecret: { name: state.gitGithubTokenSecret.trim() } }
          : {}),
        ...(state.gitAuthorName.trim() && state.gitAuthorEmail.trim()
          ? {
              author: {
                name: state.gitAuthorName.trim(),
                email: state.gitAuthorEmail.trim(),
              },
            }
          : {}),
      },
    };
  }

  // Secrets
  if (state.llmKeysSecret.trim() || state.authSecret.trim()) {
    req.secrets = {
      ...(state.llmKeysSecret.trim() ? { llmKeysSecret: state.llmKeysSecret.trim() } : {}),
      ...(state.authSecret.trim()
        ? { authSecret: { name: state.authSecret.trim() } }
        : {}),
    };
  }

  // Init script
  if (state.initScript.trim()) {
    req.initScript = state.initScript.trim();
  }

  // Sidecars
  req.sidecars = state.sidecars.length > 0
    ? state.sidecars.map((sc) => {
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

  // Inject files
  req.injectFiles = state.injectFiles
    .filter((f) => f.filename.trim())
    .map((f) => ({ filename: f.filename.trim(), content: f.content }));

  // Agents roster
  req.agents = state.rosterAgents.map((name) => ({ name }));

  // Max parallel / timeout
  const parsedMaxParallel = state.maxParallel.trim() ? parseInt(state.maxParallel.trim(), 10) : NaN;
  if (!isNaN(parsedMaxParallel) && parsedMaxParallel > 0) req.maxParallel = parsedMaxParallel;
  const parsedTimeout = state.timeoutSeconds.trim() ? parseInt(state.timeoutSeconds.trim(), 10) : NaN;
  if (!isNaN(parsedTimeout) && parsedTimeout > 0) req.timeoutSeconds = parsedTimeout;

  // Feature branching
  req.featureBranchingEnabled = state.featureBranchingEnabled;

  // Retry policy
  if (state.retryPolicyEnabled) {
    req.retryPolicy = {
      enabled: true,
      maxAttempts: parseInt(state.retryPolicyMaxAttempts, 10) || 3,
      backoffSeconds: parseInt(state.retryPolicyBackoffSeconds, 10) || 30,
      backoffMultiplier: parseFloat(state.retryPolicyBackoffMultiplier) || 2,
      maxBackoffSeconds: parseInt(state.retryPolicyMaxBackoffSeconds, 10) || 300,
      poisonPillThresholdSeconds: parseInt(state.retryPolicyPoisonPillThreshold, 10) || 30,
    };
  }

  // Review policy
  if (state.reviewPolicyAiReviewerEnabled) {
    req.reviewPolicy = {
      aiReviewerEnabled: true,
      aiReviewerAgent: state.reviewPolicyAiReviewerAgent.trim() || "reviewer",
      maxAutoReworks: parseInt(state.reviewPolicyMaxAutoReworks, 10) || 2,
    };
  }

  // Runner overrides
  if (state.runnerImage.trim()) req.image = state.runnerImage.trim();
  const resRequests: Record<string, string> = {};
  const resLimits: Record<string, string> = {};
  if (state.cpuRequest.trim()) resRequests.cpu = state.cpuRequest.trim();
  if (state.memRequest.trim()) resRequests.memory = state.memRequest.trim();
  if (state.cpuLimit.trim()) resLimits.cpu = state.cpuLimit.trim();
  if (state.memLimit.trim()) resLimits.memory = state.memLimit.trim();
  if (Object.keys(resRequests).length > 0 || Object.keys(resLimits).length > 0) {
    req.resources = {
      ...(Object.keys(resRequests).length > 0 ? { requests: resRequests } : {}),
      ...(Object.keys(resLimits).length > 0 ? { limits: resLimits } : {}),
    };
  }

  // Phase (edit mode)
  if (isEdit && state.phase !== "Active") req.phase = state.phase;

  // Git cache
  req.gitCache = { worktreeReuse: state.worktreeReuse };

  // Flow configuration
  const flowOverrides: Record<string, unknown> = {};
  if (state.flowPreset !== "plan-build-review-merge") flowOverrides.preset = state.flowPreset;
  if (state.flowHumanApprovalPlan !== "required" || state.flowHumanApprovalBuild !== "required") {
    flowOverrides.humanApproval = {
      ...(state.flowHumanApprovalPlan !== "required" ? { plan: state.flowHumanApprovalPlan } : {}),
      ...(state.flowHumanApprovalBuild !== "required" ? { build: state.flowHumanApprovalBuild } : {}),
    };
  }
  if (state.flowPlanOnApprove !== "generate-builds") {
    flowOverrides.plan = { onApprove: state.flowPlanOnApprove };
  }
  if (state.flowBuildOnSuccess !== "human-review" || state.flowBuildOnApprove !== "merge") {
    flowOverrides.build = {
      ...(state.flowBuildOnSuccess !== "human-review" ? { onSuccess: state.flowBuildOnSuccess } : {}),
      ...(state.flowBuildOnApprove !== "merge" ? { onApprove: state.flowBuildOnApprove } : {}),
    };
  }
  if (state.flowMergeMode !== "auto") {
    flowOverrides.merge = { mode: state.flowMergeMode };
  }
  if (Object.keys(flowOverrides).length > 0) {
    req.flow = flowOverrides;
  }

  // Code Server
  if (state.codeServerEnabled) {
    const csResources: Record<string, unknown> = {};
    const csResRequests: Record<string, string> = {};
    const csResLimits: Record<string, string> = {};
    if (state.csCpuRequest.trim()) csResRequests.cpu = state.csCpuRequest.trim();
    if (state.csMemRequest.trim()) csResRequests.memory = state.csMemRequest.trim();
    if (state.csCpuLimit.trim()) csResLimits.cpu = state.csCpuLimit.trim();
    if (state.csMemLimit.trim()) csResLimits.memory = state.csMemLimit.trim();
    if (Object.keys(csResRequests).length > 0) csResources.requests = csResRequests;
    if (Object.keys(csResLimits).length > 0) csResources.limits = csResLimits;
    req.codeServer = {
      enabled: true,
      ...(state.codeServerImage.trim() ? { image: state.codeServerImage.trim() } : {}),
      ...(Object.keys(csResources).length > 0 ? { resources: csResources } : {}),
    };
  }

  // Data PVC (only if any field is set)
  const dataFields: Record<string, string> = {};
  if (state.pvcName.trim()) dataFields.pvcName = state.pvcName.trim();
  if (state.mountPath !== "/data") dataFields.mountPath = state.mountPath;
  if (state.storageClass.trim()) dataFields.storageClass = state.storageClass.trim();
  if (Object.keys(dataFields).length > 0) {
    req.data = dataFields as { pvcName?: string; mountPath?: string; storageClass?: string };
  }

  // Embedding / Memory service
  if (state.embeddingEnabled) {
    req.embedding = {
      enabled: true,
      model: state.embeddingModel.trim() || undefined,
      dimensions: parseInt(state.embeddingDimensions, 10) || undefined,
      ollamaUrl: state.embeddingOllamaUrl.trim() || undefined,
    };
  }

  // Exec / Maintenance pod image
  if (state.execImage.trim()) {
    req.exec = { image: state.execImage.trim() };
  }

  return req;
}

// ---------------------------------------------------------------------------
// Hook factory — creates form state from initial project data
// ---------------------------------------------------------------------------

const EMPTY_SPEC: NonNullable<ProjectDetail["spec"]> = {} as NonNullable<ProjectDetail["spec"]>;

export function createInitialState(initialSpec: ProjectDetail["spec"] | undefined): ProjectFormState {
  const spec = initialSpec ?? EMPTY_SPEC;
  return {
    // General
    name: "",
    displayName: spec.displayName ?? "",
    model: spec.model ?? "",
    agent: spec.agent ?? "",
    maxParallel: spec.maxParallel !== undefined ? String(spec.maxParallel) : "",
    timeoutSeconds: spec.timeoutSeconds !== undefined ? String(spec.timeoutSeconds) : "",
    featureBranchingEnabled: spec.featureBranchingEnabled ?? false,
    phase: (spec.phase as "Active" | "Complete" | "Archived") ?? "Active",

    // Source & Auth
    gitUrl: spec.source?.git?.url ?? "",
    gitRef: spec.source?.git?.ref ?? "",
    gitSshSecret: spec.source?.git?.sshSecret?.name ?? "",
    gitGithubTokenSecret: spec.source?.git?.githubTokenSecret?.name ?? "",
    gitAuthorName: spec.source?.git?.author?.name ?? "",
    gitAuthorEmail: spec.source?.git?.author?.email ?? "",
    sourceLocal: spec.source?.local ?? false,
    llmKeysSecret: spec.secrets?.llmKeysSecret ?? "",
    authSecret: spec.secrets?.authSecret?.name ?? "",
    opencodeConfig: "",

    // Execution
    retryPolicyEnabled: spec.retryPolicy?.enabled ?? false,
    retryPolicyMaxAttempts: String(spec.retryPolicy?.maxAttempts ?? 3),
    retryPolicyBackoffSeconds: String(spec.retryPolicy?.backoffSeconds ?? 30),
    retryPolicyBackoffMultiplier: String(spec.retryPolicy?.backoffMultiplier ?? 2),
    retryPolicyMaxBackoffSeconds: String(spec.retryPolicy?.maxBackoffSeconds ?? 300),
    retryPolicyPoisonPillThreshold: String(spec.retryPolicy?.poisonPillThresholdSeconds ?? 30),
    reviewPolicyAiReviewerEnabled: spec.reviewPolicy?.aiReviewerEnabled ?? false,
    reviewPolicyAiReviewerAgent: spec.reviewPolicy?.aiReviewerAgent ?? "reviewer",
    reviewPolicyMaxAutoReworks: String(spec.reviewPolicy?.maxAutoReworks ?? 2),
    runnerImage: spec.image ?? "",
    cpuRequest: (spec.resources as { requests?: Record<string, string> } | undefined)?.requests?.cpu ?? "",
    memRequest: (spec.resources as { requests?: Record<string, string> } | undefined)?.requests?.memory ?? "",
    cpuLimit: (spec.resources as { limits?: Record<string, string> } | undefined)?.limits?.cpu ?? "",
    memLimit: (spec.resources as { limits?: Record<string, string> } | undefined)?.limits?.memory ?? "",
    worktreeReuse: spec.gitCache?.worktreeReuse ?? true,
    flowPreset: (spec.flow?.preset as "simple" | "review" | "plan-build" | "plan-build-review-merge") ?? "plan-build-review-merge",
    flowHumanApprovalPlan: (spec.flow?.humanApproval?.plan as "required" | "disabled") ?? "required",
    flowHumanApprovalBuild: (spec.flow?.humanApproval?.build as "required" | "disabled") ?? "required",
    flowPlanOnApprove: (spec.flow?.plan?.onApprove as "generate-builds" | "done") ?? "generate-builds",
    flowBuildOnSuccess: (spec.flow?.build?.onSuccess as "human-review" | "ai-review" | "done") ?? "human-review",
    flowBuildOnApprove: (spec.flow?.build?.onApprove as "merge" | "done") ?? "merge",
    flowMergeMode: (spec.flow?.merge?.mode as "auto" | "manual" | "disabled") ?? "auto",

    // Workspace & Services
    codeServerEnabled: spec.codeServer?.enabled ?? false,
    codeServerImage: spec.codeServer?.image ?? "codercom/code-server:4.96.4",
    csCpuRequest: (spec.codeServer?.resources as { requests?: Record<string, string> } | undefined)?.requests?.cpu ?? "",
    csMemRequest: (spec.codeServer?.resources as { requests?: Record<string, string> } | undefined)?.requests?.memory ?? "",
    csCpuLimit: (spec.codeServer?.resources as { limits?: Record<string, string> } | undefined)?.limits?.cpu ?? "",
    csMemLimit: (spec.codeServer?.resources as { limits?: Record<string, string> } | undefined)?.limits?.memory ?? "",
    pvcName: spec.data?.pvcName ?? "",
    mountPath: spec.data?.mountPath ?? "/data",
    storageClass: spec.data?.storageClass ?? "",
    embeddingEnabled: spec.embedding?.enabled ?? false,
    embeddingModel: spec.embedding?.model ?? "nomic-embed-text",
    embeddingDimensions: String(spec.embedding?.dimensions ?? 768),
    embeddingOllamaUrl: spec.embedding?.ollamaUrl ?? "",

    // Exec / Maintenance pod image
    execImage: spec.exec?.image ?? "",

    // Advanced
    sidecars: initialSidecarRows(initialSpec),
    injectFiles: [], // will be set by caller with project data
    initScript: spec.initScript ?? "",
    rosterAgents: (spec.agents ?? []).map((a: { name: string }) => a.name),
    rosterPickerValue: "",
  };
}

// ---------------------------------------------------------------------------
// Hook — returns state, setters, helpers, and validation signals
// ---------------------------------------------------------------------------

export interface ProjectFormHookReturn extends ProjectFormState {
  // Setters (all fields)
  setName: React.Dispatch<React.SetStateAction<string>>;
  setDisplayName: React.Dispatch<React.SetStateAction<string>>;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  setAgent: React.Dispatch<React.SetStateAction<string>>;
  setMaxParallel: React.Dispatch<React.SetStateAction<string>>;
  setTimeoutSeconds: React.Dispatch<React.SetStateAction<string>>;
  setFeatureBranchingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setPhase: React.Dispatch<React.SetStateAction<"Active" | "Complete" | "Archived">>;

  setGitUrl: React.Dispatch<React.SetStateAction<string>>;
  setGitRef: React.Dispatch<React.SetStateAction<string>>;
  setGitSshSecret: React.Dispatch<React.SetStateAction<string>>;
  setGitGithubTokenSecret: React.Dispatch<React.SetStateAction<string>>;
  setGitAuthorName: React.Dispatch<React.SetStateAction<string>>;
  setGitAuthorEmail: React.Dispatch<React.SetStateAction<string>>;
  setSourceLocal: React.Dispatch<React.SetStateAction<boolean>>;
  setLlmKeysSecret: React.Dispatch<React.SetStateAction<string>>;
  setAuthSecret: React.Dispatch<React.SetStateAction<string>>;
  setOpencodeConfig: React.Dispatch<React.SetStateAction<string>>;

  setRetryPolicyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setRetryPolicyMaxAttempts: React.Dispatch<React.SetStateAction<string>>;
  setRetryPolicyBackoffSeconds: React.Dispatch<React.SetStateAction<string>>;
  setRetryPolicyBackoffMultiplier: React.Dispatch<React.SetStateAction<string>>;
  setRetryPolicyMaxBackoffSeconds: React.Dispatch<React.SetStateAction<string>>;
  setRetryPolicyPoisonPillThreshold: React.Dispatch<React.SetStateAction<string>>;
  setReviewPolicyAiReviewerEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setReviewPolicyAiReviewerAgent: React.Dispatch<React.SetStateAction<string>>;
  setReviewPolicyMaxAutoReworks: React.Dispatch<React.SetStateAction<string>>;
  setRunnerImage: React.Dispatch<React.SetStateAction<string>>;
  setCpuRequest: React.Dispatch<React.SetStateAction<string>>;
  setMemRequest: React.Dispatch<React.SetStateAction<string>>;
  setCpuLimit: React.Dispatch<React.SetStateAction<string>>;
  setMemLimit: React.Dispatch<React.SetStateAction<string>>;
  setWorktreeReuse: React.Dispatch<React.SetStateAction<boolean>>;
  setFlowPreset: React.Dispatch<React.SetStateAction<"simple" | "review" | "plan-build" | "plan-build-review-merge">>;
  setFlowHumanApprovalPlan: React.Dispatch<React.SetStateAction<"required" | "disabled">>;
  setFlowHumanApprovalBuild: React.Dispatch<React.SetStateAction<"required" | "disabled">>;
  setFlowPlanOnApprove: React.Dispatch<React.SetStateAction<"generate-builds" | "done">>;
  setFlowBuildOnSuccess: React.Dispatch<React.SetStateAction<"human-review" | "ai-review" | "done">>;
  setFlowBuildOnApprove: React.Dispatch<React.SetStateAction<"merge" | "done">>;
  setFlowMergeMode: React.Dispatch<React.SetStateAction<"auto" | "manual" | "disabled">>;

  setCodeServerEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setCodeServerImage: React.Dispatch<React.SetStateAction<string>>;
  setCSCpuRequest: React.Dispatch<React.SetStateAction<string>>;
  setCSMemRequest: React.Dispatch<React.SetStateAction<string>>;
  setCSCpuLimit: React.Dispatch<React.SetStateAction<string>>;
  setCSMemLimit: React.Dispatch<React.SetStateAction<string>>;
  setPvcName: React.Dispatch<React.SetStateAction<string>>;
  setMountPath: React.Dispatch<React.SetStateAction<string>>;
  setStorageClass: React.Dispatch<React.SetStateAction<string>>;
  setEmbeddingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setEmbeddingModel: React.Dispatch<React.SetStateAction<string>>;
  setEmbeddingDimensions: React.Dispatch<React.SetStateAction<string>>;
  setEmbeddingOllamaUrl: React.Dispatch<React.SetStateAction<string>>;
  setExecImage: React.Dispatch<React.SetStateAction<string>>;

  setSidecars: React.Dispatch<React.SetStateAction<SidecarRow[]>>;
  setInjectFiles: React.Dispatch<React.SetStateAction<InjectFileRow[]>>;
  setInitScript: React.Dispatch<React.SetStateAction<string>>;
  setRosterAgents: React.Dispatch<React.SetStateAction<string[]>>;
  setRosterPickerValue: React.Dispatch<React.SetStateAction<string>>;

  // Sidecar helpers
  addSidecar: () => void;
  removeSidecar: (id: number) => void;
  updateSidecar: (id: number, field: keyof Omit<SidecarRow, "id">, value: string) => void;

  // Inject file helpers
  addInjectFile: () => void;
  removeInjectFile: (id: number) => void;
  updateInjectFile: (id: number, field: keyof Omit<InjectFileRow, "id">, value: string) => void;

  // Validation signals
  sidecarErrors: Record<number, string>;
  hasSidecarErrors: boolean;
  injectFileErrors: Record<number, string>;
  hasInjectFileErrors: boolean;
  gitAuthorIncomplete: boolean;
  configJsonError: string | null;
}

export function useProjectForm(
  initialSpec: ProjectDetail["spec"] | undefined,
  initialProject: ProjectDetail | undefined,
): ProjectFormHookReturn {
  const initialState = createInitialState(initialSpec);
  // Override injectFiles with project data (needs the full project object)
  initialState.injectFiles = initialInjectFileRows(initialProject);

  // General
  const [name, setName] = useState(initialState.name);
  const [displayName, setDisplayName] = useState(initialState.displayName);
  const [model, setModel] = useState(initialState.model);
  const [agent, setAgent] = useState(initialState.agent);
  const [maxParallel, setMaxParallel] = useState(initialState.maxParallel);
  const [timeoutSeconds, setTimeoutSeconds] = useState(initialState.timeoutSeconds);
  const [featureBranchingEnabled, setFeatureBranchingEnabled] = useState(initialState.featureBranchingEnabled);
  const [phase, setPhase] = useState<"Active" | "Complete" | "Archived">(initialState.phase);

  // Source & Auth
  const [gitUrl, setGitUrl] = useState(initialState.gitUrl);
  const [gitRef, setGitRef] = useState(initialState.gitRef);
  const [gitSshSecret, setGitSshSecret] = useState(initialState.gitSshSecret);
  const [gitGithubTokenSecret, setGitGithubTokenSecret] = useState(initialState.gitGithubTokenSecret);
  const [gitAuthorName, setGitAuthorName] = useState(initialState.gitAuthorName);
  const [gitAuthorEmail, setGitAuthorEmail] = useState(initialState.gitAuthorEmail);
  const [sourceLocal, setSourceLocal] = useState(initialState.sourceLocal);
  const [llmKeysSecret, setLlmKeysSecret] = useState(initialState.llmKeysSecret);
  const [authSecret, setAuthSecret] = useState(initialState.authSecret);
  const [opencodeConfig, setOpencodeConfig] = useState(initialState.opencodeConfig);

  // Execution
  const [retryPolicyEnabled, setRetryPolicyEnabled] = useState(initialState.retryPolicyEnabled);
  const [retryPolicyMaxAttempts, setRetryPolicyMaxAttempts] = useState(initialState.retryPolicyMaxAttempts);
  const [retryPolicyBackoffSeconds, setRetryPolicyBackoffSeconds] = useState(initialState.retryPolicyBackoffSeconds);
  const [retryPolicyBackoffMultiplier, setRetryPolicyBackoffMultiplier] = useState(initialState.retryPolicyBackoffMultiplier);
  const [retryPolicyMaxBackoffSeconds, setRetryPolicyMaxBackoffSeconds] = useState(initialState.retryPolicyMaxBackoffSeconds);
  const [retryPolicyPoisonPillThreshold, setRetryPolicyPoisonPillThreshold] = useState(initialState.retryPolicyPoisonPillThreshold);
  const [reviewPolicyAiReviewerEnabled, setReviewPolicyAiReviewerEnabled] = useState(initialState.reviewPolicyAiReviewerEnabled);
  const [reviewPolicyAiReviewerAgent, setReviewPolicyAiReviewerAgent] = useState(initialState.reviewPolicyAiReviewerAgent);
  const [reviewPolicyMaxAutoReworks, setReviewPolicyMaxAutoReworks] = useState(initialState.reviewPolicyMaxAutoReworks);
  const [runnerImage, setRunnerImage] = useState(initialState.runnerImage);
  const [cpuRequest, setCpuRequest] = useState(initialState.cpuRequest);
  const [memRequest, setMemRequest] = useState(initialState.memRequest);
  const [cpuLimit, setCpuLimit] = useState(initialState.cpuLimit);
  const [memLimit, setMemLimit] = useState(initialState.memLimit);
  const [worktreeReuse, setWorktreeReuse] = useState(initialState.worktreeReuse);
  const [flowPreset, setFlowPreset] = useState(initialState.flowPreset);
  const [flowHumanApprovalPlan, setFlowHumanApprovalPlan] = useState(initialState.flowHumanApprovalPlan);
  const [flowHumanApprovalBuild, setFlowHumanApprovalBuild] = useState(initialState.flowHumanApprovalBuild);
  const [flowPlanOnApprove, setFlowPlanOnApprove] = useState(initialState.flowPlanOnApprove);
  const [flowBuildOnSuccess, setFlowBuildOnSuccess] = useState(initialState.flowBuildOnSuccess);
  const [flowBuildOnApprove, setFlowBuildOnApprove] = useState(initialState.flowBuildOnApprove);
  const [flowMergeMode, setFlowMergeMode] = useState(initialState.flowMergeMode);

  // Workspace & Services
  const [codeServerEnabled, setCodeServerEnabled] = useState(initialState.codeServerEnabled);
  const [codeServerImage, setCodeServerImage] = useState(initialState.codeServerImage);
  const [csCpuRequest, setCSCpuRequest] = useState(initialState.csCpuRequest);
  const [csMemRequest, setCSMemRequest] = useState(initialState.csMemRequest);
  const [csCpuLimit, setCSCpuLimit] = useState(initialState.csCpuLimit);
  const [csMemLimit, setCSMemLimit] = useState(initialState.csMemLimit);
  const [pvcName, setPvcName] = useState(initialState.pvcName);
  const [mountPath, setMountPath] = useState(initialState.mountPath);
  const [storageClass, setStorageClass] = useState(initialState.storageClass);
  const [embeddingEnabled, setEmbeddingEnabled] = useState(initialState.embeddingEnabled);
  const [embeddingModel, setEmbeddingModel] = useState(initialState.embeddingModel);
  const [embeddingDimensions, setEmbeddingDimensions] = useState(initialState.embeddingDimensions);
  const [embeddingOllamaUrl, setEmbeddingOllamaUrl] = useState(initialState.embeddingOllamaUrl);
  const [execImage, setExecImage] = useState(initialState.execImage);

  // Advanced
  const [sidecars, setSidecars] = useState<SidecarRow[]>(initialState.sidecars);
  const [injectFiles, setInjectFiles] = useState<InjectFileRow[]>(initialState.injectFiles);
  const [initScript, setInitScript] = useState(initialState.initScript);
  const [rosterAgents, setRosterAgents] = useState<string[]>(initialState.rosterAgents);
  const [rosterPickerValue, setRosterPickerValue] = useState(initialState.rosterPickerValue);

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

  // Validation signals (computed inline — cheap enough for form fields count)
  const sidecarErrors = computeSidecarErrors(sidecars);
  const hasSidecarErrors = Object.keys(sidecarErrors).length > 0;
  const injectFileErrors = computeInjectFileErrors(injectFiles);
  const hasInjectFileErrors = Object.keys(injectFileErrors).length > 0;
  const gitAuthorIncomplete =
    (gitAuthorName.trim().length > 0 && gitAuthorEmail.trim().length === 0) ||
    (gitAuthorName.trim().length === 0 && gitAuthorEmail.trim().length > 0);
  const configJsonError = computeConfigJsonError(opencodeConfig);

  return {
    // General
    name, displayName, model, agent, maxParallel, timeoutSeconds, featureBranchingEnabled, phase,
    setName, setDisplayName, setModel, setAgent, setMaxParallel, setTimeoutSeconds, setFeatureBranchingEnabled, setPhase,

    // Source & Auth
    gitUrl, gitRef, gitSshSecret, gitGithubTokenSecret, gitAuthorName, gitAuthorEmail, sourceLocal, llmKeysSecret, authSecret, opencodeConfig,
    setGitUrl, setGitRef, setGitSshSecret, setGitGithubTokenSecret, setGitAuthorName, setGitAuthorEmail, setSourceLocal, setLlmKeysSecret, setAuthSecret, setOpencodeConfig,

    // Execution
    retryPolicyEnabled, retryPolicyMaxAttempts, retryPolicyBackoffSeconds, retryPolicyBackoffMultiplier, retryPolicyMaxBackoffSeconds, retryPolicyPoisonPillThreshold,
    reviewPolicyAiReviewerEnabled, reviewPolicyAiReviewerAgent, reviewPolicyMaxAutoReworks,
    runnerImage, cpuRequest, memRequest, cpuLimit, memLimit, worktreeReuse,
    flowPreset, flowHumanApprovalPlan, flowHumanApprovalBuild, flowPlanOnApprove, flowBuildOnSuccess, flowBuildOnApprove, flowMergeMode,
    setRetryPolicyEnabled, setRetryPolicyMaxAttempts, setRetryPolicyBackoffSeconds, setRetryPolicyBackoffMultiplier, setRetryPolicyMaxBackoffSeconds, setRetryPolicyPoisonPillThreshold,
    setReviewPolicyAiReviewerEnabled, setReviewPolicyAiReviewerAgent, setReviewPolicyMaxAutoReworks,
    setRunnerImage, setCpuRequest, setMemRequest, setCpuLimit, setMemLimit, setWorktreeReuse,
    setFlowPreset, setFlowHumanApprovalPlan, setFlowHumanApprovalBuild, setFlowPlanOnApprove, setFlowBuildOnSuccess, setFlowBuildOnApprove, setFlowMergeMode,

    // Workspace & Services
    codeServerEnabled, codeServerImage, csCpuRequest, csMemRequest, csCpuLimit, csMemLimit, pvcName, mountPath, storageClass, embeddingEnabled, embeddingModel, embeddingDimensions, embeddingOllamaUrl, execImage,
    setCodeServerEnabled, setCodeServerImage, setCSCpuRequest, setCSMemRequest, setCSCpuLimit, setCSMemLimit, setPvcName, setMountPath, setStorageClass, setEmbeddingEnabled, setEmbeddingModel, setEmbeddingDimensions, setEmbeddingOllamaUrl, setExecImage,

    // Advanced
    sidecars, injectFiles, initScript, rosterAgents, rosterPickerValue,
    setSidecars, setInjectFiles, setInitScript, setRosterAgents, setRosterPickerValue,

    // Helpers
    addSidecar, removeSidecar, updateSidecar,
    addInjectFile, removeInjectFile, updateInjectFile,

    // Validation
    sidecarErrors, hasSidecarErrors, injectFileErrors, hasInjectFileErrors, gitAuthorIncomplete, configJsonError,
  };
}

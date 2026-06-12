// Thin fetch wrappers for the /api endpoints.

import type {
  Run,
  LogsResponse,
  SessionResponse,
  PlanResponse,
  TaskDiffResponse,
  CreateRunRequest,
  Project,
  ProjectDetail,
  CreateProjectRequest,
  CreateAgentRequest,
  Task,
  BoardStatus,
} from "./types";
import type { ClusterAgent, ClusterSettings } from "@percussionist/api";
import { authHeaders, clearToken } from "./auth";

const BASE = "/api";

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchRuns(): Promise<Run[]> {
  const data = await fetchJSON<{ items: Run[] }>("/runs");
  return data.items;
}

export async function fetchRunsPaginated(
  limit: number,
  offset: number,
): Promise<{ items: Run[]; total: number }> {
  return fetchJSON<{ items: Run[]; total: number }>(
    `/runs?limit=${limit}&offset=${offset}`,
  );
}

export async function fetchTaskRuns(taskName: string): Promise<Run[]> {
  const data = await fetchJSON<{ items: Run[] }>(`/runs?task=${encodeURIComponent(taskName)}`);
  return data.items;
}

export async function fetchTaskEvents(
  project: string,
  taskName: string,
  limit = 50,
): Promise<Array<{
  id: number;
  project: string;
  taskName: string;
  taskType: string;
  eventType: string;
  payload: string;
  createdAt: string;
}>> {
  const data = await fetchJSON<{
    events: Array<{
      id: number;
      project: string;
      taskName: string;
      taskType: string;
      eventType: string;
      payload: string;
      createdAt: string;
    }>;
  }>(`/board/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskName)}/events?limit=${limit}`);
  return data.events;
}

export async function fetchRun(name: string): Promise<Run> {
  return fetchJSON<Run>(`/runs/${encodeURIComponent(name)}`);
}

export async function fetchLogs(
  name: string,
  container: string = "opencode",
  tailLines: number = 500,
): Promise<LogsResponse> {
  const params = new URLSearchParams({ container, tailLines: String(tailLines) });
  return fetchJSON<LogsResponse>(`/runs/${encodeURIComponent(name)}/logs?${params}`);
}

export async function fetchSession(name: string): Promise<SessionResponse> {
  return fetchJSON<SessionResponse>(`/runs/${encodeURIComponent(name)}/session`);
}

export async function fetchPlan(project: string, taskId: string): Promise<PlanResponse> {
  return fetchJSON<PlanResponse>(
    `/projects/${encodeURIComponent(project)}/plans/${encodeURIComponent(taskId)}`
  );
}

export async function fetchTaskDiff(project: string, taskName: string): Promise<TaskDiffResponse> {
  return fetchJSON<TaskDiffResponse>(
    `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskName)}/diff`
  );
}

export async function submitRun(req: CreateRunRequest): Promise<Run> {
  const res = await fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as Run;
}

export async function deleteRun(name: string): Promise<void> {
  const res = await fetch(`${BASE}/runs/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Projects

export async function fetchProjects(): Promise<Project[]> {
  const data = await fetchJSON<{ items: Project[] }>("/projects");
  return data.items;
}

export async function fetchProject(name: string): Promise<ProjectDetail> {
  return fetchJSON<ProjectDetail>(`/projects/${encodeURIComponent(name)}`);
}

export async function submitProject(req: CreateProjectRequest): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as Project;
}

export async function deleteProject(name: string): Promise<void> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function fetchProjectConfig(name: string): Promise<string> {
  return fetchJSON<string>(`/projects/${encodeURIComponent(name)}/config`);
}

export async function fetchDefaultConfig(): Promise<string> {
  return fetchJSON<string>(`/projects/config/default`);
}

export async function updateProject(name: string, req: CreateProjectRequest): Promise<Project> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as Project;
}

// ---------------------------------------------------------------------------
// Agents

export async function fetchAgents(): Promise<{ name: string; content: string }[]> {
  const data = await fetchJSON<{ agents: { name: string; content: string }[] }>("/agents");
  return data.agents;
}

export async function fetchAgent(name: string): Promise<ClusterAgent> {
  return fetchJSON<ClusterAgent>(`/agents/${encodeURIComponent(name)}`);
}

export async function submitAgent(req: CreateAgentRequest): Promise<ClusterAgent> {
  const res = await fetch(`${BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as ClusterAgent;
}

export async function updateAgent(name: string, req: CreateAgentRequest): Promise<ClusterAgent> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as ClusterAgent;
}

export async function deleteAgent(name: string): Promise<void> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Board (embedded in Project)

export async function fetchBoard(
  project: string,
): Promise<{
  settings: { maxParallel: number; agents: Array<{ name: string }>; phase: string };
  columns: Record<string, Task[]>;
  approvals?: Record<string, { approved: boolean; requestChanges: boolean }>;
  status: BoardStatus;
}> {
  return fetchJSON(`/projects/${encodeURIComponent(project)}/board`);
}

export async function addBoardTask(
  project: string,
  task: { type: string; title: string; description?: string; agent: string; priority?: string; column?: string },
): Promise<{ task: Task }> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(task),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as { task: Task };
}

export async function deleteBoardTask(
  project: string,
  taskName: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}`,
    { method: "DELETE", headers: authHeaders() },
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function retryEscalatedTask(
  project: string,
  taskName: string,
): Promise<void> {
  // Move the task back to ready via the board task move endpoint.
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}/move`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ column: "ready" }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function moveTask(
  project: string,
  taskName: string,
  column: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}/move`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ column }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function patchBoardSpec(
  project: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/spec`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}


export async function approveTask(
  project: string,
  taskId: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskId)}/approve`,
    { method: "POST", headers: authHeaders() },
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function requestChangesTask(
  project: string,
  taskId: string,
  comment: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskId)}/request-changes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ feedback: comment }),
    },
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function retryReviewTask(
  project: string,
  taskName: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}/retry-review`,
    { method: "POST", headers: authHeaders() },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Settings

export async function fetchSettings(): Promise<ClusterSettings> {
  return fetchJSON<ClusterSettings>("/settings");
}

export async function saveSettings(spec: Record<string, unknown>): Promise<ClusterSettings> {
  const res = await fetch(`${BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ spec }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as ClusterSettings;
}

export async function fetchOpencodeConfig(): Promise<string> {
  return fetchJSON<string>("/settings/opencode-config");
}

export async function listSecrets(): Promise<{ items: Array<{ name: string; keys: string[] }> }> {
  return fetchJSON<{ items: Array<{ name: string; keys: string[] }> }>("/settings/secrets");
}

export async function createSecret(name: string, data: Record<string, string>): Promise<void> {
  const res = await fetch(`${BASE}/settings/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name, data }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function updateSecret(name: string, data: Record<string, string>): Promise<void> {
  const res = await fetch(`${BASE}/settings/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function deleteSecret(name: string): Promise<void> {
  const res = await fetch(`${BASE}/settings/secrets/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export interface UpdateStatus {
  current: {
    operator: string | null;
    manager: string | null;
    web: string | null;
    dispatcher: string | null;
  };
  latest: string | null;
  updateAvailable: boolean;
  registryPrefix?: string;
  error?: string;
}

export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  return fetchJSON<UpdateStatus>("/upgrade/status");
}

export interface UpgradeResult {
  patched: string[];
  errors: string[];
  targetTag: string;
}

export async function postUpgradeApply(targetTag: string): Promise<UpgradeResult> {
  const res = await fetch(`${BASE}/upgrade/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ targetTag }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<UpgradeResult>;
}

// ---------------------------------------------------------------------------
// Providers / models

export interface ProviderModel {
  id: string;
  name: string;
  /** Context window size in tokens, if available */
  limit?: { context?: number; output?: number };
  [key: string]: unknown;
}

export interface Provider {
  id: string;
  name: string;
  models: ProviderModel[];
  [key: string]: unknown;
}

export interface ProvidersResponse {
  all: Provider[];
  default: Record<string, string>;
  connected: string[];
}

export async function fetchProviders(): Promise<ProvidersResponse> {
  return fetchJSON<ProvidersResponse>("/providers");
}

// Thin fetch wrappers for the /api endpoints.

import type { ClusterAgent, ClusterSettings } from '@percussionist/api';
import { authHeaders } from './auth';
import type {
  AgentCapability,
  BoardStatus,
  CreateAgentRequest,
  CreateMemoryRequest,
  CreateMemoryResponse,
  CreateProjectRequest,
  CreateRunRequest,
  DeleteMemoryResponse,
  ListMemoriesResponse,
  LogsResponse,
  PlanResponse,
  Project,
  ProjectDetail,
  ProjectMemory,
  Run,
  SessionResponse,
  StatSession,
  Task,
  TaskDiffResponse,
  UpdateMemoryRequest,
} from './types';
import { setGloballyLocked } from './usage-lock-state';

const BASE = '/api';

/**
 * Shared response handling for every API call: 401 → bounce to /login, 423 →
 * surface the global usage lock, any other non-OK status → throw the server's
 * error message. Mutating helpers must go through this too (via requestJSON /
 * requestVoid) so the daily usage lock and session expiry surface on every page,
 * not just the read-only fetchJSON callers.
 */
async function handleResponse(res: Response): Promise<Response> {
  if (res.status === 401) {
    // The session cookie is gone or expired; the server has already cleared it.
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (res.status === 423) {
    setGloballyLocked(true);
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? 'Locked');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res;
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return handleResponse(res);
}

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  return res.json() as Promise<T>;
}

/** Mutating helper returning a JSON body. */
async function requestJSON<T>(path: string, init: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  return res.json() as Promise<T>;
}

/** Mutating helper whose response body is not parsed (may be 204). */
async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  await apiFetch(path, init);
}

export async function fetchRuns(): Promise<Run[]> {
  const data = await fetchJSON<{ items: Run[] }>('/runs');
  return data.items;
}

export async function fetchRunsPaginated(
  limit: number,
  offset: number,
): Promise<{ items: Run[]; total: number }> {
  return fetchJSON<{ items: Run[]; total: number }>(`/runs?limit=${limit}&offset=${offset}`);
}

export async function fetchTaskRuns(taskName: string): Promise<Run[]> {
  const data = await fetchJSON<{ items: Run[] }>(`/runs?task=${encodeURIComponent(taskName)}`);
  return data.items;
}

export async function fetchTaskEvents(
  project: string,
  taskName: string,
  limit = 50,
): Promise<
  Array<{
    id: number;
    project: string;
    taskName: string;
    taskType: string;
    eventType: string;
    payload: string;
    createdAt: string;
  }>
> {
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
  }>(
    `/board/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskName)}/events?limit=${limit}`,
  );
  return data.events;
}

export async function fetchRun(name: string): Promise<Run> {
  return fetchJSON<Run>(`/runs/${encodeURIComponent(name)}`);
}

export async function fetchLogs(
  name: string,
  container: string = 'opencode',
  tailLines: number = 500,
): Promise<LogsResponse> {
  const params = new URLSearchParams({ container, tailLines: String(tailLines) });
  return fetchJSON<LogsResponse>(`/runs/${encodeURIComponent(name)}/logs?${params}`);
}

export async function fetchSession(name: string): Promise<SessionResponse> {
  return fetchJSON<SessionResponse>(`/runs/${encodeURIComponent(name)}/session`);
}

/**
 * Fetch a single session's stats-DB row by run name. The DB row outlives the
 * Run CR (deleted after runTTLDays), so this is the durable source of truth
 * for the session detail page.
 */
export async function fetchSessionStat(name: string): Promise<StatSession> {
  return fetchJSON<StatSession>(`/stats/sessions/${encodeURIComponent(name)}`);
}

export async function fetchPlan(project: string, taskId: string): Promise<PlanResponse> {
  return fetchJSON<PlanResponse>(
    `/projects/${encodeURIComponent(project)}/plans/${encodeURIComponent(taskId)}`,
  );
}

export async function fetchTaskDiff(project: string, taskName: string): Promise<TaskDiffResponse> {
  return fetchJSON<TaskDiffResponse>(
    `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskName)}/diff`,
  );
}

export async function submitRun(req: CreateRunRequest): Promise<Run> {
  return requestJSON<Run>('/runs', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function deleteRun(name: string): Promise<void> {
  await requestVoid(`/runs/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// Forward a human reply into a run's opencode session. Used by the board
// answer flow to resume a run parked on WaitingForInput.
export async function replyToRun(runName: string, message: string): Promise<void> {
  await requestVoid(`/runs/${encodeURIComponent(runName)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

// ---------------------------------------------------------------------------
// Projects

export async function fetchProjects(): Promise<Project[]> {
  const data = await fetchJSON<{ items: Project[] }>('/projects');
  return data.items;
}

export async function fetchProject(name: string): Promise<ProjectDetail> {
  return fetchJSON<ProjectDetail>(`/projects/${encodeURIComponent(name)}`);
}

export async function submitProject(req: CreateProjectRequest): Promise<Project> {
  return requestJSON<Project>('/projects', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function deleteProject(name: string): Promise<void> {
  await requestVoid(`/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function fetchProjectConfig(name: string): Promise<string> {
  return fetchJSON<string>(`/projects/${encodeURIComponent(name)}/config`);
}

export async function fetchDefaultConfig(): Promise<string> {
  return fetchJSON<string>(`/projects/config/default`);
}

export async function updateProject(name: string, req: CreateProjectRequest): Promise<Project> {
  return requestJSON<Project>(`/projects/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  });
}

// ---------------------------------------------------------------------------
// Agents

export async function fetchAgents(): Promise<
  {
    name: string;
    content: string;
    model?: string;
    capabilities?: AgentCapability[];
  }[]
> {
  const data = await fetchJSON<{
    agents: { name: string; content: string; model?: string; capabilities?: AgentCapability[] }[];
  }>('/agents');
  return data.agents;
}

export async function fetchAgent(name: string): Promise<ClusterAgent> {
  return fetchJSON<ClusterAgent>(`/agents/${encodeURIComponent(name)}`);
}

export async function submitAgent(req: CreateAgentRequest): Promise<ClusterAgent> {
  return requestJSON<ClusterAgent>('/agents', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function updateAgent(name: string, req: CreateAgentRequest): Promise<ClusterAgent> {
  return requestJSON<ClusterAgent>(`/agents/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  });
}

export async function deleteAgent(name: string): Promise<void> {
  await requestVoid(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Board (embedded in Project)

export async function fetchBoard(project: string): Promise<{
  settings: {
    maxParallel: number;
    agents: Array<{ name: string }>;
    phase: string;
    codeServer?: { enabled?: boolean };
    color?: string | null;
    repoWebUrl?: string;
    integrationMode?: string;
  };
  columns: Record<string, Task[]>;
  approvals?: Record<string, { approved: boolean; requestChanges: boolean }>;
  status: BoardStatus;
  authWarning?: string;
}> {
  return fetchJSON(`/projects/${encodeURIComponent(project)}/board`);
}

export async function addBoardTask(
  project: string,
  task: {
    type: string;
    title: string;
    description?: string;
    agent: string;
    priority?: string;
    column?: string;
  },
): Promise<{ task: Task }> {
  return requestJSON<{ task: Task }>(`/projects/${encodeURIComponent(project)}/board/tasks`, {
    method: 'POST',
    body: JSON.stringify(task),
  });
}

export async function deleteBoardTask(project: string, taskName: string): Promise<void> {
  await requestVoid(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}`,
    { method: 'DELETE' },
  );
}

export async function retryEscalatedTask(project: string, taskName: string): Promise<void> {
  // Move the task back to ready via the board task move endpoint.
  await requestVoid(
    `/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}/move`,
    {
      method: 'POST',
      body: JSON.stringify({ column: 'ready' }),
    },
  );
}

export async function moveTask(project: string, taskName: string, column: string): Promise<void> {
  await requestVoid(
    `/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}/move`,
    {
      method: 'POST',
      body: JSON.stringify({ column }),
    },
  );
}

export async function patchBoardSpec(
  project: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await requestVoid(`/projects/${encodeURIComponent(project)}/board/spec`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function approveTask(project: string, taskId: string): Promise<void> {
  await requestVoid(
    `/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskId)}/approve`,
    { method: 'POST' },
  );
}

// Write the percussionist.dev/action-abandon annotation the reconciler consumes
// (decideWaitingForInput / decideAwaitingHuman) to exit a task parked on
// waiting-for-input or awaiting-human by moving it to done.
export async function abandonTask(project: string, taskName: string): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}/abandon`,
    { method: 'POST', headers: authHeaders() },
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
  await requestVoid(
    `/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskId)}/request-changes`,
    {
      method: 'POST',
      body: JSON.stringify({ feedback: comment }),
    },
  );
}

export async function retryReviewTask(project: string, taskName: string): Promise<void> {
  await requestVoid(
    `/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}/retry-review`,
    { method: 'POST' },
  );
}

// Write the percussionist.dev/action-answer annotation the reconciler consumes
// (decideWaitingForInput) to resume a task parked on WaitingForInput. Call
// replyToRun first so the agent actually sees the human's answer.
export async function answerTask(project: string, taskName: string, answer: string): Promise<void> {
  await requestVoid(
    `/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskName)}/answer`,
    {
      method: 'POST',
      body: JSON.stringify({ answer }),
    },
  );
}

// ---------------------------------------------------------------------------
// Settings

export async function fetchSettings(): Promise<ClusterSettings> {
  return fetchJSON<ClusterSettings>('/settings');
}

export async function saveSettings(spec: Record<string, unknown>): Promise<ClusterSettings> {
  return requestJSON<ClusterSettings>('/settings', {
    method: 'PUT',
    body: JSON.stringify({ spec }),
  });
}

export async function fetchOpencodeConfig(): Promise<string> {
  return fetchJSON<string>('/settings/opencode-config');
}

export async function listSecrets(): Promise<{ items: Array<{ name: string; keys: string[] }> }> {
  return fetchJSON<{ items: Array<{ name: string; keys: string[] }> }>('/settings/secrets');
}

export async function createSecret(name: string, data: Record<string, string>): Promise<void> {
  await requestVoid('/settings/secrets', {
    method: 'POST',
    body: JSON.stringify({ name, data }),
  });
}

export async function updateSecret(name: string, data: Record<string, string>): Promise<void> {
  await requestVoid(`/settings/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}

export async function deleteSecret(name: string): Promise<void> {
  await requestVoid(`/settings/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** See UpgradeMode in server/routes/upgrade.ts. */
export type UpgradeMode = 'gitops' | 'deployments';

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
  mode?: UpgradeMode;
  source?: {
    name: string;
    namespace: string;
    tag: string | null;
    url: string;
    semverRange: string | null;
    suspended: boolean;
  };
  error?: string;
}

export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  return fetchJSON<UpdateStatus>('/upgrade/status');
}

export interface UpgradeResult {
  patched: string[];
  errors: string[];
  targetTag: string;
  mode?: UpgradeMode;
  warnings?: string[];
}

export async function postUpgradeApply(targetTag: string): Promise<UpgradeResult> {
  return requestJSON<UpgradeResult>('/upgrade/apply', {
    method: 'POST',
    body: JSON.stringify({ targetTag }),
  });
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
  return fetchJSON<ProvidersResponse>('/providers');
}

// ---------------------------------------------------------------------------
// Project memories

export async function fetchProjectMemories(
  project: string,
  options?: { limit?: number; offset?: number; task?: string },
): Promise<ListMemoriesResponse> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  if (options?.task) params.set('task', options.task);
  return fetchJSON<ListMemoriesResponse>(
    `/projects/${encodeURIComponent(project)}/memories?${params}`,
  );
}

export interface MemoryHealth {
  ok: boolean;
  reachable: boolean;
  status?: number;
  error?: string;
}

export async function fetchMemoryHealth(project: string): Promise<MemoryHealth> {
  return fetchJSON<MemoryHealth>(`/projects/${encodeURIComponent(project)}/memories/health`);
}

export async function fetchProjectMemory(project: string, id: string): Promise<ProjectMemory> {
  return fetchJSON<ProjectMemory>(
    `/projects/${encodeURIComponent(project)}/memories/${encodeURIComponent(id)}`,
  );
}

export async function createProjectMemory(
  project: string,
  req: CreateMemoryRequest,
): Promise<CreateMemoryResponse> {
  return requestJSON<CreateMemoryResponse>(`/projects/${encodeURIComponent(project)}/memories`, {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function updateProjectMemory(
  project: string,
  id: string,
  req: UpdateMemoryRequest,
): Promise<ProjectMemory> {
  return requestJSON<ProjectMemory>(
    `/projects/${encodeURIComponent(project)}/memories/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(req),
    },
  );
}

export async function deleteProjectMemory(
  project: string,
  id: string,
): Promise<DeleteMemoryResponse> {
  await requestVoid(`/projects/${encodeURIComponent(project)}/memories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return { deleted: true };
}

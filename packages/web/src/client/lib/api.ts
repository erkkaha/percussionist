// Thin fetch wrappers for the /api endpoints.

import type {
  OpenCodeRun,
  LogsResponse,
  SessionResponse,
  CreateRunRequest,
  OpenCodeProject,
  CreateProjectRequest,
  CreateAgentRequest,
  BoardTask,
  BoardSpec,
  BoardStatus,
} from "./types";
import type { ClusterAgent } from "@percussionist/api";

const BASE = "/api";

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchRuns(): Promise<OpenCodeRun[]> {
  const data = await fetchJSON<{ items: OpenCodeRun[] }>("/runs");
  return data.items;
}

export async function fetchRun(name: string): Promise<OpenCodeRun> {
  return fetchJSON<OpenCodeRun>(`/runs/${encodeURIComponent(name)}`);
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

export async function submitRun(req: CreateRunRequest): Promise<OpenCodeRun> {
  const res = await fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as OpenCodeRun;
}

export async function deleteRun(name: string): Promise<void> {
  const res = await fetch(`${BASE}/runs/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Projects

export async function fetchProjects(): Promise<OpenCodeProject[]> {
  const data = await fetchJSON<{ items: OpenCodeProject[] }>("/projects");
  return data.items;
}

export async function fetchProject(name: string): Promise<OpenCodeProject> {
  return fetchJSON<OpenCodeProject>(`/projects/${encodeURIComponent(name)}`);
}

export async function submitProject(req: CreateProjectRequest): Promise<OpenCodeProject> {
  const res = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as OpenCodeProject;
}

export async function deleteProject(name: string): Promise<void> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function updateProject(name: string, req: CreateProjectRequest): Promise<OpenCodeProject> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as OpenCodeProject;
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
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Board (embedded in OpenCodeProject)

export async function fetchBoard(
  project: string,
): Promise<{ spec: BoardSpec; status: BoardStatus }> {
  return fetchJSON(`/projects/${encodeURIComponent(project)}/board`);
}

export async function addBoardTask(
  project: string,
  task: BoardTask,
): Promise<{ task: BoardTask }> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as { task: BoardTask };
}

export async function deleteBoardTask(
  project: string,
  taskId: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/tasks/${encodeURIComponent(taskId)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function patchBoardStatus(
  project: string,
  patch: Partial<BoardStatus>,
): Promise<BoardStatus> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(project)}/board/status`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as BoardStatus;
}

// Thin fetch wrappers for the /api endpoints.

import type { OpenCodeRun, LogsResponse, SessionResponse, CreateRunRequest } from "./types";

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

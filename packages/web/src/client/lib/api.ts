// Thin fetch wrappers for the /api endpoints.

import type { OpenCodeRun, LogsResponse, SessionResponse } from "./types";

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

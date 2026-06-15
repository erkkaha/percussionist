import { authHeaders } from './auth';
import { setGloballyLocked } from './usage-lock-state';

export type Category = 'reviewing' | 'planning' | 'other';

export type UsageSettings = {
  maxTimeHours: number;
  showPercent: boolean;
  lockOnMax: boolean;
};

export type ProjectUsageCounters = {
  reviewing: number;
  planning: number;
};

export type TodayUsage = Record<Category, number> & {
  projects: Record<string, ProjectUsageCounters>;
};

export type UsageServerResponse = {
  locked: boolean;
  reviewing: number;
  planning: number;
  other: number;
  total: number;
  projectUsage: Record<string, ProjectUsageCounters>;
  settings: UsageSettings;
};

export const STORAGE_PREFIX = 'percussionist-usage';

export function getTodayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${STORAGE_PREFIX}-${yyyy}-${mm}-${dd}`;
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function parseProjectUsage(value: unknown): Record<string, ProjectUsageCounters> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const projects: Record<string, ProjectUsageCounters> = {};

  for (const [project, counters] of entries) {
    const name = project.trim();
    if (!name || !counters || typeof counters !== 'object') {
      continue;
    }

    const typedCounters = counters as { reviewing?: unknown; planning?: unknown };
    projects[name] = {
      reviewing: toNonNegativeNumber(typedCounters.reviewing),
      planning: toNonNegativeNumber(typedCounters.planning),
    };
  }

  return projects;
}

export function readTodayUsage(): TodayUsage {
  try {
    const key = getTodayKey();
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as {
        reviewing?: unknown;
        planning?: unknown;
        other?: unknown;
        projects?: unknown;
      };
      return {
        reviewing: toNonNegativeNumber(parsed.reviewing),
        planning: toNonNegativeNumber(parsed.planning),
        other: toNonNegativeNumber(parsed.other),
        projects: parseProjectUsage(parsed.projects),
      };
    }
  } catch {
    // ignore
  }
  return { reviewing: 0, planning: 0, other: 0, projects: {} };
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Server data cache (updated by tracker's heartbeat, read by UsageBar)

let _serverCache: UsageServerResponse | null = null;

export function getServerCache(): UsageServerResponse | null {
  return _serverCache;
}

export function setServerCache(data: UsageServerResponse): void {
  _serverCache = data;
}

// ---------------------------------------------------------------------------
// Server API wrappers

const BASE = '/api';

async function fetchUsageJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 423) {
    setGloballyLocked(true);
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? 'Locked');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function reportHeartbeat(usage: TodayUsage): Promise<UsageServerResponse> {
  const payload: {
    reviewing: number;
    planning: number;
    other: number;
    projectUsage?: Record<string, ProjectUsageCounters>;
  } = {
    reviewing: usage.reviewing,
    planning: usage.planning,
    other: usage.other,
  };

  if (Object.keys(usage.projects).length > 0) {
    payload.projectUsage = usage.projects;
  }

  return fetchUsageJSON<UsageServerResponse>('/usage/heartbeat', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchUsageToday(): Promise<UsageServerResponse> {
  return fetchUsageJSON<UsageServerResponse>('/usage/today');
}

export async function fetchServerSettings(): Promise<UsageSettings> {
  return fetchUsageJSON<UsageSettings>('/usage/settings');
}

export async function updateServerSettings(
  partial: Partial<UsageSettings>,
): Promise<UsageSettings> {
  return fetchUsageJSON<UsageSettings>('/usage/settings', {
    method: 'PUT',
    body: JSON.stringify(partial),
  });
}

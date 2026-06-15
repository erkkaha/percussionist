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

export function readTodayUsage(): Record<Category, number> {
  try {
    const key = getTodayKey();
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as Record<Category, number>;
      return {
        reviewing: parsed.reviewing || 0,
        planning: parsed.planning || 0,
        other: parsed.other || 0,
      };
    }
  } catch {
    // ignore
  }
  return { reviewing: 0, planning: 0, other: 0 };
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

export async function reportHeartbeat(
  usage: Record<Category, number>,
): Promise<UsageServerResponse> {
  return fetchUsageJSON<UsageServerResponse>('/usage/heartbeat', {
    method: 'POST',
    body: JSON.stringify(usage),
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

export type Category = 'reviewing' | 'planning' | 'other';

export type UsageSettings = {
  maxTimeHours: number;
  showPercent: boolean;
  lockOnMax: boolean;
};

const SETTINGS_KEY = 'percussionist-usage-settings';
export const STORAGE_PREFIX = 'percussionist-usage';

const DEFAULTS: UsageSettings = {
  maxTimeHours: 0,
  showPercent: false,
  lockOnMax: false,
};

export function getTodayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${STORAGE_PREFIX}-${yyyy}-${mm}-${dd}`;
}

export function readUsageSettings(): UsageSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<UsageSettings>) };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

export function writeUsageSettings(value: UsageSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
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

export function isLocked(): boolean {
  const settings = readUsageSettings();
  if (settings.maxTimeHours === 0 || !settings.lockOnMax) return false;

  const maxSeconds = settings.maxTimeHours * 3600;
  const data = readTodayUsage();
  const total = data.reviewing + data.planning + data.other;
  return total >= maxSeconds;
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

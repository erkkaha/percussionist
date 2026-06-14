export type UsageSettings = {
  maxTimeHours: number;
  showPercent: boolean;
  lockOnMax: boolean;
};

const STORAGE_KEY = 'percussionist-usage-settings';

const DEFAULTS: UsageSettings = {
  maxTimeHours: 0,
  showPercent: false,
  lockOnMax: false,
};

export function readUsageSettings(): UsageSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<UsageSettings>) };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

export function writeUsageSettings(value: UsageSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

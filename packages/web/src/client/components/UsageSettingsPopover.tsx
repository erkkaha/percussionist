import { Settings } from 'lucide-react';
import { useState } from 'react';
import { readUsageSettings, type UsageSettings, writeUsageSettings } from '../lib/usage-settings';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';

const MAX_HOURS_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '1', label: '1 hour' },
  { value: '2', label: '2 hours' },
  { value: '3', label: '3 hours' },
  { value: '4', label: '4 hours' },
  { value: '5', label: '5 hours' },
  { value: '6', label: '6 hours' },
  { value: '8', label: '8 hours' },
  { value: '10', label: '10 hours' },
  { value: '12', label: '12 hours' },
  { value: '16', label: '16 hours' },
];

export function UsageSettingsPopover() {
  const [settings, setSettings] = useState<UsageSettings>(readUsageSettings);

  function update(partial: Partial<UsageSettings>) {
    const next = { ...settings, ...partial };
    setSettings(next);
    writeUsageSettings(next);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 opacity-40 hover:opacity-80 transition-opacity"
          aria-label="Usage settings"
        >
          <Settings size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">Usage Settings</p>

          <div className="flex items-center justify-between">
            <label className="text-xs text-sidebar-foreground/80">Max daily time</label>
            <Select
              value={String(settings.maxTimeHours)}
              onValueChange={(v) => update({ maxTimeHours: Number(v) })}
            >
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAX_HOURS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-xs text-sidebar-foreground/80">Show percentage</label>
            <Switch
              checked={settings.showPercent}
              onCheckedChange={(v) => update({ showPercent: v })}
            />
          </div>

          <div className="flex items-center justify-between">
            <label className="text-xs text-sidebar-foreground/80">Lock at 100%</label>
            <Switch
              checked={settings.lockOnMax}
              onCheckedChange={(v) => update({ lockOnMax: v })}
              disabled={settings.maxTimeHours === 0}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

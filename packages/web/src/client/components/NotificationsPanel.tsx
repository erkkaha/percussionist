import { Play, Volume2, VolumeX } from 'lucide-react';
import { type DrumSound, playDrum } from '../lib/notifications';
import { NOTIFICATION_SOUNDS, useNotificationStore } from '../stores/settingsStore';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Switch } from './ui/switch';

export default function NotificationsPanel() {
  const soundEnabled = useNotificationStore((s) => s.soundEnabled);
  const setSoundEnabled = useNotificationStore((s) => s.setSoundEnabled);
  const selectedSound = useNotificationStore((s) => s.selectedSound);
  const setSelectedSound = useNotificationStore((s) => s.setSelectedSound);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          {soundEnabled ? (
            <Volume2 className="h-5 w-5 text-accent" />
          ) : (
            <VolumeX className="h-5 w-5 text-text-dim" />
          )}
          <CardTitle>Notifications</CardTitle>
        </div>
        <CardDescription>
          Control notification sound playback. Preferences are stored locally in your browser and
          persist across page reloads.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Sound toggle */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Play notification sounds</span>
            <span className="text-xs text-text-dim">
              {soundEnabled
                ? 'Sounds will play on run events'
                : 'All notification sounds are muted'}
            </span>
          </div>
          <Switch
            checked={soundEnabled}
            onCheckedChange={(checked: boolean) => setSoundEnabled(checked)}
          />
        </div>

        {soundEnabled && (
          <>
            <Separator />

            {/* Selected sound */}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Default notification sound</span>
              <select
                value={selectedSound}
                onChange={(e) => setSelectedSound(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {NOTIFICATION_SOUNDS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Sound preview list */}
            <div className="flex flex-col gap-3">
              <span className="text-sm font-medium">Preview sounds</span>
              {NOTIFICATION_SOUNDS.map((sound) => (
                <div key={sound.id} className="flex items-center justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm">{sound.label}</span>
                    <span className="text-xs text-text-dim">{sound.description}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => playDrum(sound.id as DrumSound)}
                    className="gap-1.5 shrink-0"
                  >
                    <Play className="h-3 w-3" />
                    Play
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

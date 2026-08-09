import { Play, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type DrumSound, playDrum } from '../lib/notifications';
import {
  getPushSubscription,
  isPushSupported,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
} from '../lib/push';
import { NOTIFICATION_SOUNDS, useNotificationStore } from '../stores/settingsStore';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Switch } from './ui/switch';

/** Push section state: resolving on mount, then either unsupported or a live toggle. */
type PushState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'ready'; enabled: boolean; busy: boolean; error?: string };

function PushSection() {
  const [state, setState] = useState<PushState>({ kind: 'loading' });

  useEffect(() => {
    if (!isPushSupported()) {
      setState({ kind: 'unsupported' });
      return;
    }
    getPushSubscription().then((sub) =>
      setState({ kind: 'ready', enabled: sub !== null, busy: false }),
    );
  }, []);

  if (state.kind === 'loading') return null;

  if (state.kind === 'unsupported') {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text-dim">Push notifications</span>
        <span className="text-xs text-text-dim">
          Unavailable here — push needs a production build served over HTTPS (or localhost).
        </span>
      </div>
    );
  }

  const toggle = async (checked: boolean) => {
    setState({ ...state, busy: true, error: undefined });
    try {
      if (checked) await subscribeToPush();
      else await unsubscribeFromPush();
      setState({ kind: 'ready', enabled: checked, busy: false });
    } catch (e) {
      setState({ kind: 'ready', enabled: !checked, busy: false, error: (e as Error).message });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Push notifications</span>
          <span className="text-xs text-text-dim">
            {state.enabled
              ? 'This device gets notified even with the dashboard closed'
              : 'Notify this device even when the dashboard is closed'}
          </span>
        </div>
        <Switch checked={state.enabled} disabled={state.busy} onCheckedChange={toggle} />
      </div>
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
      {state.enabled && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start gap-1.5"
          onClick={() =>
            sendTestPush().catch((e) =>
              setState((s) => (s.kind === 'ready' ? { ...s, error: (e as Error).message } : s)),
            )
          }
        >
          Send test notification
        </Button>
      )}
    </div>
  );
}

export default function NotificationsPanel() {
  const soundEnabled = useNotificationStore((s) => s.soundEnabled);
  const setSoundEnabled = useNotificationStore((s) => s.setSoundEnabled);

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
        {/* Web Push (server-sent, works with the tab closed) */}
        <PushSection />

        <Separator />

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

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Separator } from "./ui/separator";
import { playDrum, getNotificationPreferences, setNotificationPreferences, type DrumSound } from "../lib/notifications";

interface SoundInfo {
  name: string;
  description: string;
  sound: DrumSound;
}

const SOUND_LIST: SoundInfo[] = [
  { name: "Success", description: "Rimshot — played when a run succeeds", sound: "success" },
  { name: "Failure", description: "Low tom thud — played when a run fails", sound: "failure" },
  { name: "Cancelled", description: "Muted cymbal — played when a run is cancelled", sound: "cancelled" },
  { name: "Escalated", description: "Double hi-hat tick — played on task escalation", sound: "escalated" },
  { name: "Running", description: "Short kick drum — played when a run starts", sound: "running" },
];

export default function NotificationsPanel() {
  const prefs = getNotificationPreferences();
  const [soundEnabled, setSoundEnabled] = useState(prefs.soundEnabled);

  // Persist immediately on toggle change.
  function handleToggleChange(next: boolean) {
    setSoundEnabled(next);
    setNotificationPreferences({ soundEnabled: next });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Control notification sounds and preview the available drum hits.
          Preferences are stored locally in your browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Sound toggle */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Play notification sounds</span>
          <Switch
            checked={soundEnabled}
            onCheckedChange={handleToggleChange}
          />
        </div>

        {/* Sound preview section — only shown when enabled */}
        {soundEnabled && (
          <>
            <Separator />
            <p className="text-sm font-medium">Sound Preview</p>
            <div className="flex flex-col gap-2">
              {SOUND_LIST.map((s) => (
                <div
                  key={s.sound}
                  className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-surface-overlay"
                >
                  <div>
                    <p className="text-sm font-medium">{s.name}</p>
                    <p className="text-xs text-text-dim">{s.description}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => playDrum(s.sound)}
                  >
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

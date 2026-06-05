import { create } from "zustand";
import { persist, type PersistOptions } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Notification sound preferences — persisted in localStorage under a unique key.
// No server round-trip needed; per-user since Percussionist has no accounts.

export const NOTIFICATION_PREFS_KEY = "percussionist:notifications";

export interface NotificationSettings {
  soundEnabled: boolean;
  selectedSound: string;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  soundEnabled: true,
  selectedSound: "success",
};

/** Available notification drum sounds with display labels and descriptions. */
export const NOTIFICATION_SOUNDS: Array<{
  id: string;
  label: string;
  description: string;
}> = [
  { id: "success", label: "Success", description: "Rimshot — played when a run succeeds" },
  { id: "failure", label: "Failure", description: "Low tom thud — played when a run fails" },
  { id: "cancelled", label: "Cancelled", description: "Muted cymbal — played when a run is cancelled" },
  { id: "escalated", label: "Escalated", description: "Double hi-hat tick — played on board escalations" },
  { id: "running", label: "Running", description: "Short kick drum — played when a run starts" },
];

export const useNotificationStore = create<NotificationSettings & {
  setSoundEnabled: (enabled: boolean) => void;
  setSelectedSound: (sound: string) => void;
}>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setSoundEnabled: (enabled: boolean) => set({ soundEnabled: enabled }),
      setSelectedSound: (sound: string) => set({ selectedSound: sound }),
    }),
    {
      name: NOTIFICATION_PREFS_KEY,
      version: 1,
    } satisfies PersistOptions<NotificationSettings>,
  ),
);

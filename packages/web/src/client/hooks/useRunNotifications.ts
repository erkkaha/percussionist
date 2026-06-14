// useRunNotifications.ts — fires browser notifications + drum sounds on run phase transitions.
//
// Watches for runs entering terminal phases (Succeeded, Failed, Cancelled).
// Call this hook wherever you have access to the full run list (Layout).

import { useEffect, useRef } from 'react';
import { notify, requestNotificationPermission } from '../lib/notifications';
import type { Run } from '../lib/types';
import { RunPhase } from '../lib/types';

export function useRunNotifications(runs: Run[] | undefined): void {
  // Map of runName → last-seen phase.
  const prevPhases = useRef<Map<string, RunPhase>>(new Map());

  // Request permission once on mount.
  useEffect(() => {
    requestNotificationPermission().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!runs) return;

    for (const run of runs) {
      const name = run.metadata.name;
      const phase = run.status?.phase;
      if (!phase) continue;

      const prev = prevPhases.current.get(name);

      if (prev !== phase) {
        // Only notify on transitions INTO terminal phases.
        if (phase === RunPhase.Succeeded && prev !== undefined) {
          notify({
            key: `run:${name}:${phase}`,
            title: `Run succeeded`,
            body: name,
            sound: 'success',
          });
        } else if (phase === RunPhase.Failed && prev !== undefined) {
          notify({
            key: `run:${name}:${phase}`,
            title: `Run failed`,
            body: `${name}${run.status?.message ? ` — ${run.status.message}` : ''}`,
            sound: 'failure',
          });
        } else if (phase === RunPhase.Cancelled && prev !== undefined) {
          notify({
            key: `run:${name}:${phase}`,
            title: `Run cancelled`,
            body: name,
            sound: 'cancelled',
          });
        }

        prevPhases.current.set(name, phase);
      }
    }
  }, [runs]);
}

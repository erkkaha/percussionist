// useBoardNotifications.ts — fires browser notifications + drum sounds on worker status transitions.
//
// Watches board workers for status changes: Running, Succeeded, Failed, Escalated.
// Call this hook inside BoardView where you have the board data.

import { useEffect, useRef } from "react";
import type { WorkerStatus } from "@percussionist/api";
import { notify } from "../lib/notifications";

export function useBoardNotifications(
  projectName: string,
  workers: WorkerStatus[],
): void {
  // Map of taskId → last-seen status.
  const prevStatuses = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    for (const worker of workers) {
      const { taskId, status } = worker;
      const prev = prevStatuses.current.get(taskId);

      if (prev !== status) {
        if (prev !== undefined) {
          // Only notify on actual transitions (not initial population).
          if (status === "Succeeded") {
            notify({
              key: `board:${projectName}:${taskId}:${status}`,
              title: `Task succeeded`,
              body: `${taskId} in ${projectName}`,
              sound: "success",
            });
          } else if (status === "Failed") {
            notify({
              key: `board:${projectName}:${taskId}:${status}`,
              title: `Task failed`,
              body: `${taskId} in ${projectName}`,
              sound: "failure",
            });
          } else if (status === "Escalated") {
            notify({
              key: `board:${projectName}:${taskId}:${status}`,
              title: `Task escalated`,
              body: `${taskId} in ${projectName} needs attention`,
              sound: "escalated",
            });
          } else if (status === "Running") {
            notify({
              key: `board:${projectName}:${taskId}:${status}`,
              title: `Task started`,
              body: `${taskId} in ${projectName}`,
              sound: "running",
            });
          }
        }

        prevStatuses.current.set(taskId, status);
      }
    }
  }, [projectName, workers]);
}

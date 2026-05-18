// useBoardNotifications.ts — fires browser notifications + drum sounds on worker status transitions.
//
// Watches board tasks for status changes: Running, Succeeded, Failed, Escalated.
// Call this hook inside BoardView where you have the board data.

import { useEffect, useRef } from "react";
import type { Task } from "@percussionist/api";
import { notify } from "../lib/notifications";

export function useBoardNotifications(
  projectName: string,
  tasks: Task[],
): void {
  // Map of taskName → last-seen worker status.
  const prevStatuses = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    for (const task of tasks) {
      const taskName = task.metadata.name;
      const status = task.status?.worker?.status;
      if (!status) continue;
      const prev = prevStatuses.current.get(taskName);

      if (prev !== status) {
        if (prev !== undefined) {
          // Only notify on actual transitions (not initial population).
          const label = task.spec.title || taskName;
          if (status === "Succeeded") {
            notify({
              key: `board:${projectName}:${taskName}:${status}`,
              title: `Task succeeded`,
              body: `${label} in ${projectName}`,
              sound: "success",
            });
          } else if (status === "Failed") {
            notify({
              key: `board:${projectName}:${taskName}:${status}`,
              title: `Task failed`,
              body: `${label} in ${projectName}`,
              sound: "failure",
            });
          } else if (status === "Escalated") {
            notify({
              key: `board:${projectName}:${taskName}:${status}`,
              title: `Task escalated`,
              body: `${label} in ${projectName} needs attention`,
              sound: "escalated",
            });
          } else if (status === "Running") {
            notify({
              key: `board:${projectName}:${taskName}:${status}`,
              title: `Task started`,
              body: `${label} in ${projectName}`,
              sound: "running",
            });
          }
        }

        prevStatuses.current.set(taskName, status);
      }
    }
  }, [projectName, tasks]);
}

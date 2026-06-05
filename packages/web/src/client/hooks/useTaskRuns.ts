import { useQuery } from "@tanstack/react-query";
import { fetchTaskRuns } from "../lib/api";
import type { Run } from "../lib/types";
import { TERMINAL_PHASES } from "../lib/types";

export function useTaskRuns(
  taskName: string | null,
  refetchInterval: number | false = 5_000,
) {
  return useQuery<Run[], Error>({
    queryKey: ["taskRuns", taskName],
    queryFn: () => fetchTaskRuns(taskName!),
    enabled: !!taskName,
    refetchInterval: (query) => {
      const runs = query.state.data;
      if (!runs) return refetchInterval;
      const allTerminal = runs.every(
        (r) => r.status?.phase && TERMINAL_PHASES.has(r.status.phase),
      );
      if (allTerminal) return false;
      return refetchInterval;
    },
  });
}

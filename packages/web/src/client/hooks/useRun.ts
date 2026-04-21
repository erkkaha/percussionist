import { useQuery } from "@tanstack/react-query";
import { fetchRun } from "../lib/api";
import type { OpenCodeRun } from "../lib/types";
import { TERMINAL_PHASES } from "../lib/types";

export function useRun(name: string, refetchInterval = 3_000) {
  return useQuery<OpenCodeRun, Error>({
    queryKey: ["run", name],
    queryFn: () => fetchRun(name),
    refetchInterval: (query) => {
      // Stop polling once run reaches a terminal phase.
      const phase = query.state.data?.status?.phase;
      if (phase && TERMINAL_PHASES.has(phase)) return false;
      return refetchInterval;
    },
  });
}

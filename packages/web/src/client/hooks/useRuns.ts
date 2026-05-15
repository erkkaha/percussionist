import { useQuery } from "@tanstack/react-query";
import { fetchRuns } from "../lib/api";
import type { OpenCodeRun } from "../lib/types";

export function useRuns(
  refetchInterval: number | false = 5_000,
  eventTick: number = 0,
) {
  return useQuery<OpenCodeRun[], Error>({
    queryKey: ["runs", eventTick],
    queryFn: fetchRuns,
    refetchInterval,
  });
}

import { useQuery } from "@tanstack/react-query";
import { fetchRuns } from "../lib/api";
import type { OpenCodeRun } from "../lib/types";

export function useRuns(refetchInterval = 5_000) {
  return useQuery<OpenCodeRun[], Error>({
    queryKey: ["runs"],
    queryFn: fetchRuns,
    refetchInterval,
  });
}

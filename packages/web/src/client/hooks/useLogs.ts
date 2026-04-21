import { useQuery } from "@tanstack/react-query";
import { fetchLogs } from "../lib/api";
import type { LogsResponse } from "../lib/types";

export function useLogs(
  name: string,
  container: string = "opencode",
  tailLines: number = 500,
  enabled: boolean = true,
  refetchInterval = 5_000,
) {
  return useQuery<LogsResponse, Error>({
    queryKey: ["logs", name, container, tailLines],
    queryFn: () => fetchLogs(name, container, tailLines),
    enabled,
    refetchInterval,
  });
}

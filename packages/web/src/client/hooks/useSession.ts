import { useQuery } from "@tanstack/react-query";
import { fetchSession } from "../lib/api";
import type { SessionResponse } from "../lib/types";

export function useSession(
  name: string,
  enabled: boolean = true,
  refetchInterval: number | false = 5_000,
) {
  return useQuery<SessionResponse, Error>({
    queryKey: ["session", name],
    queryFn: () => fetchSession(name),
    enabled,
    refetchInterval,
    retry: 1,
  });
}

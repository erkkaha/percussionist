import { useQuery } from "@tanstack/react-query";
import { fetchKanbans, fetchKanban } from "../lib/api";
import type { OpenCodeKanban } from "../lib/types";

export function useKanbans(refetchInterval = 10_000) {
  return useQuery<OpenCodeKanban[], Error>({
    queryKey: ["kanbans"],
    queryFn: fetchKanbans,
    refetchInterval,
  });
}

export function useKanban(name: string, refetchInterval = 10_000) {
  return useQuery<OpenCodeKanban, Error>({
    queryKey: ["kanban", name],
    queryFn: () => fetchKanban(name),
    refetchInterval,
    enabled: !!name,
  });
}

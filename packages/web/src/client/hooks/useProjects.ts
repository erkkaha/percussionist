import { useQuery } from "@tanstack/react-query";
import { fetchProjects } from "../lib/api";
import type { OpenCodeProject } from "../lib/types";

export function useProjects(
  refetchInterval: number | false = 10_000,
) {
  return useQuery<OpenCodeProject[], Error>({
    queryKey: ["projects"],
    queryFn: fetchProjects,
    refetchInterval,
  });
}

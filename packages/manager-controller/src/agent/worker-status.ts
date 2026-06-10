import type { WorkerStatus } from "@percussionist/api";

type WorkerLike = Partial<WorkerStatus> & Record<string, unknown>;

export function clearWorkerRunRefs(worker?: WorkerLike): WorkerLike {
  return {
    ...(worker ?? {}),
    runName: null as unknown as undefined,
    reviewRunName: null as unknown as undefined,
    mergeRunName: null as unknown as undefined,
    buildTasksFacilitatorRun: null as unknown as undefined,
  };
}

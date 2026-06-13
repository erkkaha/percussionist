import type { WorkerStatus } from '@percussionist/api';

export function clearWorkerRunRefs(): Pick<
  WorkerStatus,
  'runName' | 'reviewRunName' | 'mergeRunName' | 'buildTasksFacilitatorRun'
> {
  return {
    runName: null as unknown as undefined,
    reviewRunName: null as unknown as undefined,
    mergeRunName: null as unknown as undefined,
    buildTasksFacilitatorRun: null as unknown as undefined,
  };
}

import { describe, expect, it } from "bun:test";
import { clearWorkerRunRefs } from "../worker-status.js";

describe("clearWorkerRunRefs", () => {
  it("replaces run reference fields with null while preserving other fields", () => {
    const cleared = clearWorkerRunRefs({
      runName: "run-1",
      reviewRunName: "review-1",
      mergeRunName: "merge-1",
      buildTasksFacilitatorRun: "buildgen-1",
      status: "Failed",
      retryCount: 2,
    });

    expect(cleared).toEqual({
      runName: null,
      reviewRunName: null,
      mergeRunName: null,
      buildTasksFacilitatorRun: null,
      status: "Failed",
      retryCount: 2,
    });
  });
});

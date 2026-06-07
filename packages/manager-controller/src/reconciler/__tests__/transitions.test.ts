import { describe, it, expect } from "bun:test";
import {
  isValidTransition,
  validateTransition,
  TRANSITION_TABLE,
} from "../transitions.js";

describe("TRANSITION_TABLE", () => {
  it("covers all TaskPhase values", () => {
    const phases = [
      "idea",
      "pending",
      "scheduled",
      "initializing",
      "running",
      "waiting-for-input",
      "succeeded",
      "reviewing",
      "awaiting-human",
      "awaiting-merge",
      "rework-requested",
      "generating-builds",
      "done",
      "failed",
    ] as const;

    for (const phase of phases) {
      expect(TRANSITION_TABLE).toHaveProperty(phase);
      expect(Array.isArray(TRANSITION_TABLE[phase])).toBe(true);
    }
  });

  it("has no outgoing transitions from done", () => {
    expect(TRANSITION_TABLE["done"]).toEqual([]);
  });
});

describe("isValidTransition", () => {
  it("accepts valid transitions", () => {
    expect(isValidTransition("pending", "scheduled")).toBe(true);
    expect(isValidTransition("scheduled", "initializing")).toBe(true);
    expect(isValidTransition("running", "succeeded")).toBe(true);
    expect(isValidTransition("running", "failed")).toBe(true);
    expect(isValidTransition("succeeded", "reviewing")).toBe(true);
    expect(isValidTransition("succeeded", "awaiting-human")).toBe(true);
    expect(isValidTransition("awaiting-human", "awaiting-merge")).toBe(true);
    expect(isValidTransition("awaiting-human", "generating-builds")).toBe(true);
    expect(isValidTransition("awaiting-human", "rework-requested")).toBe(true);
    expect(isValidTransition("awaiting-human", "done")).toBe(true);
    expect(isValidTransition("rework-requested", "scheduled")).toBe(true);
    expect(isValidTransition("failed", "pending")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(isValidTransition("pending", "done")).toBe(false);
    expect(isValidTransition("pending", "running")).toBe(false);
    expect(isValidTransition("done", "pending")).toBe(false);
    expect(isValidTransition("done", "scheduled")).toBe(false);
    expect(isValidTransition("running", "awaiting-merge")).toBe(false);
    expect(isValidTransition("succeeded", "running")).toBe(false);
  });

  it("rejects same-phase transitions", () => {
    expect(isValidTransition("pending", "pending")).toBe(false);
    expect(isValidTransition("running", "running")).toBe(false);
    expect(isValidTransition("done", "done")).toBe(false);
  });
});

describe("validateTransition", () => {
  it("returns null for valid transitions", () => {
    expect(validateTransition("pending", "scheduled")).toBeNull();
    expect(validateTransition("failed", "pending")).toBeNull();
  });

  it("returns error message for invalid transitions", () => {
    const err = validateTransition("pending", "done");
    expect(err).toMatch(/Invalid transition/);
    expect(err).toMatch(/pending.*done/);
  });

  it("includes allowed phases in error message", () => {
    const err = validateTransition("pending", "done");
    expect(err).toMatch(/scheduled/);
  });
});

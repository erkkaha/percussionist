// spec-validation.ts — Zod re-validation of Run/Project specs at reconcile entry.
//
// The generated CRDs are built from these schemas via z.toJSONSchema, which has
// no representation for .refine() — so the CRDs carry no CEL equivalents of
// the refine rules and the apiserver admits specs that violate them (e.g. a Run
// with neither `task` nor `interactive`, or a source with both `git` and
// `local`). The operator is the enforcement point: every reconcile re-parses
// the spec against the Zod schema before doing any work, so an invalid spec is
// failed loudly with an actionable status message instead of being reconciled
// into an undefined state.
//
// This module is pure — no kube clients, no side effects — so it is trivially
// unit-testable and safe to call from any reconcile path.

import { ProjectSpecSchema, RunSpecSchema } from '@percussionist/api';

export type SpecValidationResult = { ok: true } | { ok: false; error: string };

/** Formats Zod issues as `<path.join('.')>: <message>`, joined by `'; '`. */
function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

export function validateRunSpec(spec: unknown): SpecValidationResult {
  const parsed = RunSpecSchema.safeParse(spec);
  if (parsed.success) return { ok: true };
  return { ok: false, error: formatIssues(parsed.error.issues) };
}

export function validateProjectSpec(spec: unknown): SpecValidationResult {
  const parsed = ProjectSpecSchema.safeParse(spec);
  if (parsed.success) return { ok: true };
  return { ok: false, error: formatIssues(parsed.error.issues) };
}

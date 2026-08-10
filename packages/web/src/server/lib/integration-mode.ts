// integration-mode.ts — resolve a project's effective feature-branch
// integration mode for display in the board UI.
//
// This intentionally duplicates a slice of the preset-default table owned by
// the reconciler's resolveFlow() in
// packages/manager-controller/src/reconciler/flow.ts (~line 145), which is
// the authoritative source. The web server does not depend on
// manager-controller, so this is a small, deliberately-scoped mirror rather
// than a cross-package dependency. Keep the two in sync if preset defaults
// change.

import type { Project } from '@percussionist/api';

type IntegrationMode = 'auto-merge' | 'pr' | 'manual' | 'disabled';

const PRESET_DEFAULT_MODE: Record<string, IntegrationMode> = {
  simple: 'disabled',
  review: 'disabled',
  'plan-build': 'auto-merge',
  'plan-build-review-merge': 'auto-merge',
};

export function resolveIntegrationMode(project: Project): IntegrationMode {
  if (!project.spec.featureBranchingEnabled) return 'disabled';

  const preset = project.spec.flow?.preset ?? 'plan-build-review-merge';
  const presetDefault = PRESET_DEFAULT_MODE[preset] ?? 'auto-merge';
  return project.spec.flow?.integration?.mode ?? presetDefault;
}

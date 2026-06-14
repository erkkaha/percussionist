// adapters/opencode-config.ts — resolves the effective RunnerImageSpec for a
// reconcile cycle by merging OPENCODE_RUNNER_DEFAULTS with any override
// supplied in ClusterSettings.spec.runnerAdapter.

import {
  type ClusterSettings,
  OPENCODE_RUNNER_DEFAULTS,
  type RunnerImageSpec,
} from '@percussionist/api';

/**
 * Returns the effective RunnerImageSpec for this cluster.
 * If ClusterSettings is absent or has no runnerAdapter override, the default
 * opencode spec is returned as-is.
 */
export function resolveRunnerSpec(cs?: ClusterSettings): RunnerImageSpec {
  const override = cs?.spec?.runnerAdapter;
  if (!override) return OPENCODE_RUNNER_DEFAULTS;
  return {
    ...OPENCODE_RUNNER_DEFAULTS,
    ...Object.fromEntries(
      Object.entries(override).filter(([, v]) => v !== undefined && v !== null),
    ),
  } as RunnerImageSpec;
}

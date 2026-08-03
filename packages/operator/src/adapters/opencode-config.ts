// adapters/opencode-config.ts — resolves the effective RunnerImageSpec for a
// reconcile cycle by merging the engine's defaults with any override supplied
// in ClusterSettings.spec.runnerAdapter.

import {
  type ClusterSettings,
  type RunnerEngine,
  type RunnerImageSpec,
  runnerDefaultsFor,
} from '@percussionist/api';

/**
 * Returns the effective RunnerImageSpec for this run.
 *
 * The baseline comes from the requested engine (opencode unless stated), then
 * ClusterSettings.spec.runnerAdapter is layered on top. The override is
 * engine-independent by design: a cluster that pins a custom runner image gets
 * it whichever engine is selected, which is what lets air-gapped registries
 * work without per-engine configuration.
 */
export function resolveRunnerSpec(cs?: ClusterSettings, engine?: RunnerEngine): RunnerImageSpec {
  const defaults = runnerDefaultsFor(engine);
  const override = cs?.spec?.runnerAdapter;
  if (!override) return defaults;
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(override).filter(([, v]) => v !== undefined && v !== null),
    ),
  } as RunnerImageSpec;
}

/**
 * Marks a permanent Run misconfiguration, as opposed to a transient error.
 * Callers can use `instanceof ValidationError` to route these to a terminal
 * status patch instead of the usual retry-with-backoff path.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Guards the one credential mistake that fails silently.
 *
 * `ANTHROPIC_API_KEY` overrides subscription auth unconditionally, and in
 * non-interactive mode it is used whenever present — no prompt, no warning. A
 * run configured with both an LLM-keys Secret and a subscription authSecret
 * therefore bills per token while looking like it is on the subscription.
 * Refuse the combination rather than let it run wrong.
 */
export function assertCredentialsUnambiguous(opts: {
  engine?: RunnerEngine;
  llmKeysSecret?: string;
  authSecretName?: string;
  runName: string;
}): void {
  if (opts.engine !== 'claude') return;
  if (!opts.llmKeysSecret || !opts.authSecretName) return;
  throw new ValidationError(
    `Run ${opts.runName}: engine "claude" has both spec.secrets.llmKeysSecret ` +
      `(${opts.llmKeysSecret}) and spec.secrets.authSecret (${opts.authSecretName}) set. ` +
      `ANTHROPIC_API_KEY silently overrides subscription auth, so this run would bill ` +
      `per token while appearing to use the subscription. Remove one.`,
  );
}

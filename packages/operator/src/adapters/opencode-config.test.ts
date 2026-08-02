import { describe, expect, test } from 'bun:test';
import { CLAUDE_RUNNER_DEFAULTS, OPENCODE_RUNNER_DEFAULTS } from '@percussionist/api';
import {
  assertCredentialsUnambiguous,
  resolveRunnerSpec,
  ValidationError,
} from './opencode-config.js';

describe('resolveRunnerSpec', () => {
  test('defaults to opencode when no engine is given', () => {
    expect(resolveRunnerSpec(undefined, undefined)).toEqual(OPENCODE_RUNNER_DEFAULTS);
  });

  test('returns the claude defaults for engine claude', () => {
    expect(resolveRunnerSpec(undefined, 'claude')).toEqual(CLAUDE_RUNNER_DEFAULTS);
  });

  // authEnvVar is what makes the existing authSecret injection in pod-builder
  // deliver the subscription token without any engine-specific plumbing.
  test('claude defaults inject the token via the standard auth env var', () => {
    expect(resolveRunnerSpec(undefined, 'claude').authEnvVar).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  // The dispatcher reads OPENCODE_BASE_URL to find the runner regardless of
  // engine; renaming it would silently strand the sidecar.
  test('claude defaults keep the dispatcher base-url variable', () => {
    expect(resolveRunnerSpec(undefined, 'claude').baseUrlEnvVar).toBe('OPENCODE_BASE_URL');
  });

  test('ClusterSettings overrides layer over the engine defaults', () => {
    const cs = {
      spec: { runnerAdapter: { image: 'registry.internal/runner:v9' } },
    } as Parameters<typeof resolveRunnerSpec>[0];
    const spec = resolveRunnerSpec(cs, 'claude');
    expect(spec.image).toBe('registry.internal/runner:v9');
    expect(spec.authEnvVar).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  test('null and undefined override values do not clobber defaults', () => {
    const cs = {
      spec: { runnerAdapter: { image: undefined, port: null } },
    } as unknown as Parameters<typeof resolveRunnerSpec>[0];
    expect(resolveRunnerSpec(cs, 'claude')).toEqual(CLAUDE_RUNNER_DEFAULTS);
  });
});

describe('assertCredentialsUnambiguous', () => {
  const base = { runName: 'percussionist/run-1' };

  test('rejects an API key alongside subscription auth on the claude engine', () => {
    expect(() =>
      assertCredentialsUnambiguous({
        ...base,
        engine: 'claude',
        llmKeysSecret: 'llm-keys',
        authSecretName: 'claude-oat',
      }),
    ).toThrow(/silently overrides subscription auth/);
  });

  test('throws a ValidationError so callers can route it to a terminal status', () => {
    expect(() =>
      assertCredentialsUnambiguous({
        ...base,
        engine: 'claude',
        llmKeysSecret: 'llm-keys',
        authSecretName: 'claude-oat',
      }),
    ).toThrow(ValidationError);
  });

  test('allows subscription auth alone', () => {
    expect(() =>
      assertCredentialsUnambiguous({ ...base, engine: 'claude', authSecretName: 'claude-oat' }),
    ).not.toThrow();
  });

  test('allows an API key alone', () => {
    expect(() =>
      assertCredentialsUnambiguous({ ...base, engine: 'claude', llmKeysSecret: 'llm-keys' }),
    ).not.toThrow();
  });

  // opencode multiplexes several providers and legitimately wants both.
  test('does not constrain the opencode engine', () => {
    expect(() =>
      assertCredentialsUnambiguous({
        ...base,
        engine: 'opencode',
        llmKeysSecret: 'llm-keys',
        authSecretName: 'oc-auth',
      }),
    ).not.toThrow();
  });
});

// pod-builder falls back to `opencode serve ...` when runner.command is unset.
// The runner-claude image has no opencode binary, so an unset command means the
// container cannot exec and the run dies on the health check with "fetch failed"
// — which is exactly how this failed the first time it was deployed.
describe('claude engine launch command', () => {
  test('claude defaults specify an explicit command', () => {
    const cmd = resolveRunnerSpec(undefined, 'claude').command;
    expect(cmd).toBeDefined();
    expect(cmd?.[0]).toBe('node');
  });

  test('the command does not invoke the opencode binary', () => {
    expect(resolveRunnerSpec(undefined, 'claude').command?.join(' ')).not.toContain('opencode');
  });
});

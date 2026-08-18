import { describe, expect, it } from 'bun:test';
import { KubeConfig } from '@kubernetes/client-node';
import { readKubeconfigToken } from '../index.js';

// Regression test for the context-vs-user lookup bug: readKubeconfigToken
// previously called kc.getUser(currentContext), but getUser() searches users[]
// by *user* name. When a context name differs from its user name (virtually
// all cloud kubeconfigs — minikube only works because both happen to share a
// name), getUser(contextName) returns null and every metrics helper throws
// "No service account token available" in local dev.

/** Build a KubeConfig whose current context name differs from its user name. */
function makeKubeConfig(opts: { token?: string } = {}): KubeConfig {
  const kc = new KubeConfig();
  kc.addCluster({ name: 'cluster-a', server: 'https://example.com', skipTLSVerify: true });
  kc.addUser({ name: 'user-42', ...(opts.token ? { token: opts.token } : {}) });
  kc.addContext({ name: 'context-7', cluster: 'cluster-a', user: 'user-42' });
  kc.setCurrentContext('context-7');
  return kc;
}

describe('readKubeconfigToken', () => {
  it('resolves the token when context name differs from user name', () => {
    const kc = makeKubeConfig({ token: 'known-token-123' });
    // Sanity: the scenario only exercises the bug if the names really differ
    // and the old getUser(contextName) lookup would miss.
    expect(kc.getCurrentContext()).toBe('context-7');
    expect(kc.getUser('context-7')).toBeNull();
    expect(kc.getCurrentUser()?.name).toBe('user-42');
    expect(readKubeconfigToken(kc)).toBe('known-token-123');
  });

  it('trims surrounding whitespace from the token', () => {
    const kc = makeKubeConfig({ token: '  padded-token  \n' });
    expect(readKubeconfigToken(kc)).toBe('padded-token');
  });

  it('returns undefined when the current user has no token', () => {
    const kc = makeKubeConfig();
    expect(readKubeconfigToken(kc)).toBeUndefined();
  });

  it('returns undefined when no context is set', () => {
    const kc = new KubeConfig();
    kc.addUser({ name: 'user-42', token: 'known-token-123' });
    expect(readKubeconfigToken(kc)).toBeUndefined();
  });
});

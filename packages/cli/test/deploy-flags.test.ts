// deploy-flags.test.ts — the `--platform` / `--skip-tls` flag plumbing.
//
// `parseDeployArgs` turns a `beatctl deploy` argv into a `DeployOpts` using the
// same option definitions the CLI uses, so this asserts that commander maps the
// kebab-case flags to the camelCase `DeployOpts` keys (e.g. `--skip-tls` →
// `skipTls`, `--platform` → `platform`, `--http-port` → `httpPort`) without
// running a real deploy.

import { describe, expect, it } from 'bun:test';
import { parseDeployArgs } from '../src/index.js';

describe('parseDeployArgs — DeployOpts mapping', () => {
  it('maps --platform and --skip-tls to DeployOpts', () => {
    const opts = parseDeployArgs(['--platform', 'microk8s', '--skip-tls']);
    expect(opts.platform).toBe('microk8s');
    expect(opts.skipTls).toBe(true);
  });

  it('defaults platform to auto and skipTls to false when omitted', () => {
    const opts = parseDeployArgs([]);
    expect(opts.platform).toBe('auto');
    expect(opts.skipTls).toBe(false);
  });

  it('coerces and maps every platform knob', () => {
    const opts = parseDeployArgs([
      '--platform',
      'minikube',
      '--domain',
      'pcs.example.com',
      '--http-port',
      '80',
      '--https-port',
      '443',
      '--storage-class',
      'longhorn',
      '--ingress-class',
      'traefik',
      '--tls-secret',
      'ns/sec',
    ]);
    expect(opts.platform).toBe('minikube');
    expect(opts.domain).toBe('pcs.example.com');
    expect(opts.httpPort).toBe(80);
    expect(opts.httpsPort).toBe(443);
    expect(opts.storageClass).toBe('longhorn');
    expect(opts.ingressClass).toBe('traefik');
    expect(opts.tlsSecret).toBe('ns/sec');
  });

  it('https-port stays a number even when non-standard (microk8s NodePort pin)', () => {
    const opts = parseDeployArgs(['--https-port', '30443']);
    expect(opts.httpsPort).toBe(30443);
    expect(typeof opts.httpsPort).toBe('number');
  });
});

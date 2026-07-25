// kube-errors.test.ts — Regression tests for Kubernetes error status detection.
//
// Every route used to derive its status with `e.statusCode === 404`. That works
// for one of the shapes @kubernetes/client-node throws, but not the other: some
// paths surface a plain Error whose message embeds the status, e.g.
//
//   Error: HTTP-Code: 404
//   Message: Unknown API Status Code!
//   Body: "{"kind":"Status",...,"reason":"NotFound",...}"
//
// Those were misreported as 500. Concretely, GET /api/settings on a cluster with
// no ClusterSettings object returned 500 instead of an empty document, which
// made the dashboard login probe fail on every fresh install.

import { describe, expect, it } from 'bun:test';
import { isKubeNotFound, kubeStatusCode } from '../src/server/lib/kube-errors.ts';

/** The real message shape observed from a missing ClusterSettings. */
const EMBEDDED_404 = `HTTP-Code: 404
Message: Unknown API Status Code!
Body: "{\\"kind\\":\\"Status\\",\\"apiVersion\\":\\"v1\\",\\"metadata\\":{},\\"status\\":\\"Failure\\",\\"message\\":\\"clustersettings.percussionist.dev \\\\\\"default\\\\\\" not found\\",\\"reason\\":\\"NotFound\\"}"`;

describe('kubeStatusCode', () => {
  it('reads a direct statusCode property', () => {
    expect(kubeStatusCode({ statusCode: 404 })).toBe(404);
    expect(kubeStatusCode({ statusCode: 409 })).toBe(409);
  });

  it('falls back to code and response.statusCode', () => {
    expect(kubeStatusCode({ code: 404 })).toBe(404);
    expect(kubeStatusCode({ response: { statusCode: 400 } })).toBe(400);
  });

  it('parses the status out of an embedded HTTP-Code message', () => {
    expect(kubeStatusCode(new Error(EMBEDDED_404))).toBe(404);
    expect(kubeStatusCode(new Error('HTTP-Code: 400\nMessage: bad'))).toBe(400);
  });

  it('returns undefined when no status can be determined', () => {
    expect(kubeStatusCode(new Error('socket hang up'))).toBeUndefined();
    expect(kubeStatusCode(undefined)).toBeUndefined();
  });
});

describe('isKubeNotFound', () => {
  it('detects both error shapes', () => {
    expect(isKubeNotFound({ statusCode: 404 })).toBe(true);
    expect(isKubeNotFound(new Error(EMBEDDED_404))).toBe(true);
  });

  it('detects a NotFound reason without an explicit HTTP-Code', () => {
    expect(isKubeNotFound(new Error('{"reason":"NotFound"}'))).toBe(true);
  });

  it('does not treat other failures as not-found', () => {
    expect(isKubeNotFound({ statusCode: 500 })).toBe(false);
    expect(isKubeNotFound({ statusCode: 403 })).toBe(false);
    expect(isKubeNotFound(new Error('HTTP-Code: 500'))).toBe(false);
    expect(isKubeNotFound(new Error('connection refused'))).toBe(false);
  });
});

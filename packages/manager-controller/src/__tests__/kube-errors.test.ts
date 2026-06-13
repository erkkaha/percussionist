import { describe, expect, it } from 'bun:test';
import { getErrorStatusCode, isKubeNotFoundError } from '../kube-errors.js';

describe('kube-errors', () => {
  it('extracts status code from common Kubernetes client error shapes', () => {
    expect(getErrorStatusCode({ statusCode: 404 })).toBe(404);
    expect(getErrorStatusCode({ code: '404' })).toBe(404);
    expect(getErrorStatusCode({ response: { statusCode: 404 } })).toBe(404);
    expect(getErrorStatusCode({ response: { status: '404' } })).toBe(404);
    expect(getErrorStatusCode({ body: { code: 404 } })).toBe(404);
    expect(getErrorStatusCode({ details: { code: '404' } })).toBe(404);
    expect(getErrorStatusCode({ cause: { statusCode: 404 } })).toBe(404);
  });

  it('detects not found from code or reason', () => {
    expect(isKubeNotFoundError({ statusCode: 404 })).toBe(true);
    expect(isKubeNotFoundError({ response: { statusCode: 404 } })).toBe(true);
    expect(isKubeNotFoundError({ body: { reason: 'NotFound' } })).toBe(true);
    expect(isKubeNotFoundError({ reason: 'notfound' })).toBe(true);
    expect(isKubeNotFoundError({ statusCode: 500 })).toBe(false);
    expect(isKubeNotFoundError(new Error('boom'))).toBe(false);
  });
});

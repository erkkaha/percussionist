// ideUrl resolution: ClusterSettings.spec.codeServerUrlTemplate is
// authoritative when set; otherwise fall back to deriving from
// window.location (dashboard-subdomain convention).
import { describe, expect, it } from 'bun:test';
import { deriveIdeUrl, ideUrl } from '../src/client/lib/code-server-url';

describe('ideUrl', () => {
  it('substitutes {project} into the template when one is configured', () => {
    expect(ideUrl('my-proj', 'https://ide-{project}.10.148.28.70.nip.io')).toBe(
      'https://ide-my-proj.10.148.28.70.nip.io',
    );
  });

  it('substitutes every occurrence of {project}', () => {
    expect(ideUrl('p1', 'https://{project}.example.com/{project}/')).toBe(
      'https://p1.example.com/p1/',
    );
  });

  it('falls back to window.location derivation without a template', () => {
    // happy-dom default origin has a multi-label host, so derivation applies.
    expect(ideUrl('my-proj', undefined)).toBe(deriveIdeUrl('my-proj'));
  });

  it('template wins even when the dashboard host has no subdomain', () => {
    expect(ideUrl('my-proj', 'http://ide-{project}.internal')).toBe('http://ide-my-proj.internal');
  });
});

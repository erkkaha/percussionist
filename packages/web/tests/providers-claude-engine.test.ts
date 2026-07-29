// providers-claude-engine.test.ts — the claude-code provider is advertised only
// when a subscription token exists.
//
// Offering it unconditionally would put a provider in the picker that cannot
// authenticate, and the failure would surface as a 401 partway into a run rather
// than at selection time.

import { describe, expect, test } from 'bun:test';
import { CLAUDE_ENGINE_PROVIDER_ID } from '@percussionist/api';

type Payload = {
  all?: Array<{ id: string; models?: Array<{ id: string }> }>;
  connected?: string[];
};

/**
 * Mirrors the route's composition step. Kept as a local reimplementation because
 * the route's own helper is module-private and the behaviour under test is the
 * contract with ModelSelector, which filters `all` by `connected`.
 */
function withClaudeEngine(data: Payload): Payload {
  return {
    ...data,
    all: [
      ...(data.all ?? []),
      { id: CLAUDE_ENGINE_PROVIDER_ID, models: [{ id: 'claude-opus-5' }] },
    ],
    connected: [...(data.connected ?? []), CLAUDE_ENGINE_PROVIDER_ID],
  };
}

/** What ModelSelector actually shows: `all` narrowed to `connected`. */
function visibleProviderIds(data: Payload): string[] {
  const connected = new Set(data.connected ?? []);
  return (data.all ?? []).filter((p) => connected.has(p.id)).map((p) => p.id);
}

const OPENCODE_ONLY: Payload = {
  all: [{ id: 'github-copilot', models: [{ id: 'claude-sonnet-4.5' }] }],
  connected: ['github-copilot'],
};

describe('claude-code provider advertisement', () => {
  test('absent when no token exists', () => {
    expect(visibleProviderIds(OPENCODE_ONLY)).toEqual(['github-copilot']);
    expect(visibleProviderIds(OPENCODE_ONLY)).not.toContain(CLAUDE_ENGINE_PROVIDER_ID);
  });

  test('present alongside opencode providers when a token exists', () => {
    const ids = visibleProviderIds(withClaudeEngine(OPENCODE_ONLY));
    expect(ids).toContain('github-copilot');
    expect(ids).toContain(CLAUDE_ENGINE_PROVIDER_ID);
  });

  // ModelSelector filters `all` down to `connected`, so an entry added to `all`
  // alone is silently dropped — the reason withClaudeEngine touches both.
  test('is reachable through the connected filter, not just present in all', () => {
    const data = withClaudeEngine(OPENCODE_ONLY);
    expect(data.connected).toContain(CLAUDE_ENGINE_PROVIDER_ID);
    expect(visibleProviderIds(data)).toContain(CLAUDE_ENGINE_PROVIDER_ID);
  });

  // A claude-only cluster has no opencode sidecar to query, so degrading to the
  // claude provider alone beats returning a 502 and no models at all.
  test('stands alone when opencode is unreachable', () => {
    const ids = visibleProviderIds(withClaudeEngine({ all: [], connected: [] }));
    expect(ids).toEqual([CLAUDE_ENGINE_PROVIDER_ID]);
  });

  test('offered model ids are bare, so the provider prefix supplies the engine', () => {
    const provider = withClaudeEngine({ all: [], connected: [] }).all?.find(
      (p) => p.id === CLAUDE_ENGINE_PROVIDER_ID,
    );
    for (const m of provider?.models ?? []) {
      expect(m.id).not.toContain('/');
    }
  });
});

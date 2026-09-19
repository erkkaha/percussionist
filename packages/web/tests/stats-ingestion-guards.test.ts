import { describe, expect, it } from 'bun:test';
import { MAX_SESSION_BODY_BYTES, readSessionPayload } from '../src/server/routes/stats.js';

describe('stats ingestion body limit', () => {
  it('rejects an oversized body even when Content-Length understates it', async () => {
    const req = new Request('http://localhost/api/stats/session', {
      method: 'POST',
      headers: { 'Content-Length': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(MAX_SESSION_BODY_BYTES) }),
    });

    await expect(readSessionPayload(req)).rejects.toThrow('payload too large');
  });

  it('parses a body below the limit', async () => {
    const req = new Request('http://localhost/api/stats/session', {
      method: 'POST',
      body: JSON.stringify({ sessionID: 'session-1', run: { name: 'run-1' } }),
    });

    await expect(readSessionPayload(req)).resolves.toMatchObject({
      sessionID: 'session-1',
      run: { name: 'run-1' },
    });
  });
});

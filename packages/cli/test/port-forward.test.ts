// port-forward.test.ts — deterministic unit test for the shared port-forward
// helpers. pickFreePort must return an ephemeral port and release it so the
// returned number is immediately bindable again.

import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:net';
import { pickFreePort } from '../src/port-forward.ts';

describe('pickFreePort', () => {
  it('returns a positive integer port and releases it for immediate reuse', async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);

    // The probe socket must be closed — bind a real server on the returned port.
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve());
    });
    srv.close();
  });
});

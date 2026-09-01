// doctor-util.test.ts — withProbeTimeout (E item): a non-positive or non-finite
// probe timeout must fail loudly instead of silently disabling the timeout
// bound and racing nothing.

import { describe, expect, it } from 'bun:test';
import { withProbeTimeout } from '../src/doctor-util.js';

describe('withProbeTimeout', () => {
  it('resolves when the promise settles within the bound', async () => {
    await expect(withProbeTimeout(Promise.resolve(42), 1000, 'probe')).resolves.toBe(42);
  });

  it('rejects with a labelled timeout error when the promise overruns', async () => {
    await expect(withProbeTimeout(new Promise(() => {}), 10, 'slow probe')).rejects.toThrow(
      'slow probe timed out after 10ms',
    );
  });

  it('throws for ms = 0 instead of silently disabling the bound', async () => {
    await expect(withProbeTimeout(Promise.resolve(1), 0, 'probe')).rejects.toThrow(
      /invalid probe timeout for "probe": 0/,
    );
  });

  it('throws for negative ms', async () => {
    await expect(withProbeTimeout(Promise.resolve(1), -5, 'probe')).rejects.toThrow(
      /invalid probe timeout for "probe": -5/,
    );
  });

  it('throws for non-finite ms', async () => {
    await expect(withProbeTimeout(Promise.resolve(1), Number.NaN, 'probe')).rejects.toThrow(
      /invalid probe timeout for "probe": NaN/,
    );
  });
});

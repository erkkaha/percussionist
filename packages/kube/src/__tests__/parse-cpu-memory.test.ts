import { describe, expect, it } from 'bun:test';
import { addCpu, addMemory, parseCpuRaw, parseMemoryRaw } from '../index.js';

// Regression tests for the quantity-parser rewrite. The old implementations
// used parseInt(), which truncates at the decimal point, so fractional
// quantities ("0.5" cores, "0.5Gi", "1.5G") all parsed to 0. The new parsers
// accept a decimal mantissa via regex and understand the Kubernetes suffix
// set (CPU: n/u/m/bare; memory: binary Ki/Mi/Gi/Ti and SI K/M/G/T).

describe('parseCpuRaw', () => {
  it('keeps exact behavior for integer forms that were already correct', () => {
    expect(parseCpuRaw('100m')).toBe(100);
    expect(parseCpuRaw('1')).toBe(1000);
    expect(parseCpuRaw('2500n')).toBe(0);
    expect(parseCpuRaw('0')).toBe(0);
  });

  it('converts a bare fractional core to milli-cores', () => {
    expect(parseCpuRaw('0.5')).toBe(500);
  });

  it('rounds a fractional milli value', () => {
    expect(parseCpuRaw('0.5m')).toBe(Math.round(0.5));
  });

  it('rejects SI suffixes — not valid for CPU quantities', () => {
    expect(parseCpuRaw('100M')).toBe(0);
    expect(parseCpuRaw('1G')).toBe(0);
    expect(parseCpuRaw('1Ki')).toBe(0);
  });

  it('returns 0 for garbage input', () => {
    expect(parseCpuRaw('abc')).toBe(0);
    expect(parseCpuRaw('')).toBe(0);
    expect(parseCpuRaw('-5m')).toBe(0);
    expect(parseCpuRaw('1.5.5')).toBe(0);
  });
});

describe('parseMemoryRaw', () => {
  it('keeps exact behavior for integer forms that were already correct', () => {
    expect(parseMemoryRaw('536870912')).toBe(512);
    expect(parseMemoryRaw('100Mi')).toBe(100);
    expect(parseMemoryRaw('0')).toBe(0);
  });

  it('converts SI M to MiB', () => {
    expect(parseMemoryRaw('100M')).toBe(95);
  });

  it('converts fractional GiB to MiB', () => {
    expect(parseMemoryRaw('0.5Gi')).toBe(512);
  });

  it('converts fractional SI G to MiB', () => {
    expect(parseMemoryRaw('1.5G')).toBe(1431);
  });

  it('rounds small binary quantities down to 0', () => {
    expect(parseMemoryRaw('100Ki')).toBe(0);
  });

  it('handles the remaining binary and SI suffix ladder', () => {
    expect(parseMemoryRaw('2048Ki')).toBe(2);
    expect(parseMemoryRaw('2Gi')).toBe(2048);
    expect(parseMemoryRaw('1Ti')).toBe(1048576);
    expect(parseMemoryRaw('100K')).toBe(0);
    expect(parseMemoryRaw('1G')).toBe(954);
    expect(parseMemoryRaw('1T')).toBe(953674);
  });

  it('returns 0 for garbage input', () => {
    expect(parseMemoryRaw('abc')).toBe(0);
    expect(parseMemoryRaw('')).toBe(0);
    expect(parseMemoryRaw('-1Mi')).toBe(0);
    expect(parseMemoryRaw('1.5.5Gi')).toBe(0);
  });
});

describe('addCpu / addMemory', () => {
  it('sums cpu quantities into milli-cores', () => {
    expect(addCpu('100m', '200m')).toBe('300m');
    expect(addCpu('0.5', '500m')).toBe('1000m');
  });

  it('sums memory quantities into MiB', () => {
    expect(addMemory('100Mi', '200Mi')).toBe('300Mi');
    expect(addMemory('0.5Gi', '100Mi')).toBe('612Mi');
  });
});

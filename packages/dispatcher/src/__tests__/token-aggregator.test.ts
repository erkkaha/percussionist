import { describe, expect, it } from 'bun:test';
import { TokenAggregator } from '../polling.js';

// The aggregator used to key on session alone and take the max, so a run's
// reported usage was its single largest message rather than the run. Observed
// on a real build run: 16 messages totalling 172 output tokens were reported as
// 59, and because prompt caching leaves each message's uncached `input` at 2,
// every run in `beatctl ls` showed an input of 2 no matter how large it was.
describe('TokenAggregator', () => {
  it('sums distinct messages rather than reporting the largest', () => {
    const agg = new TokenAggregator();
    agg.update('s1', 'm1', 2, 5);
    agg.update('s1', 'm2', 2, 53);
    agg.update('s1', 'm3', 2, 59);

    const t = agg.totals();
    expect(t.tokensOut).toBe(117);
    expect(t.tokensIn).toBe(6);
  });

  it('does not double-count a message delivered more than once', () => {
    const agg = new TokenAggregator();
    // The poller re-reads the whole message list every tick, so the same
    // message arrives repeatedly with identical counts.
    agg.update('s1', 'm1', 2, 5);
    agg.update('s1', 'm1', 2, 5);
    agg.update('s1', 'm1', 2, 5);

    const t = agg.totals();
    expect(t.tokensOut).toBe(5);
    expect(t.tokensIn).toBe(2);
  });

  it('keeps the latest counts while a message streams', () => {
    const agg = new TokenAggregator();
    // A streaming message is re-delivered as its counts grow; only the final
    // value should land, not the sum of every intermediate delivery.
    agg.update('s1', 'm1', 2, 10);
    agg.update('s1', 'm1', 2, 40);
    agg.update('s1', 'm1', 2, 59);

    expect(agg.totals().tokensOut).toBe(59);
  });

  it('accumulates cache reads, which carry the real input volume', () => {
    const agg = new TokenAggregator();
    // With prompt caching, per-message `input` stays tiny and the context is
    // billed as cache reads — reporting input alone understates a run by
    // orders of magnitude.
    agg.update('s1', 'm1', 2, 5, 0, 23_693);
    agg.update('s1', 'm2', 2, 53, 0, 47_320);

    const t = agg.totals();
    expect(t.tokensCacheRead).toBe(71_013);
    expect(t.tokensIn).toBe(4);
  });

  it('keeps separate sessions separate but totals across them', () => {
    const agg = new TokenAggregator();
    // Message ids are only unique within a session, so the key must include it.
    agg.update('s1', 'm1', 2, 10);
    agg.update('s2', 'm1', 2, 30);

    expect(agg.totals().tokensOut).toBe(40);
  });
});

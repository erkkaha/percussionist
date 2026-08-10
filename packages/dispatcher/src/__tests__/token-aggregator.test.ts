import { describe, expect, it } from 'bun:test';
import { recordUsage, TokenAggregator } from '../polling.js';

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

// The poller used to feed only the transcript tail into the aggregator, so a
// run's reported usage depended on how many distinct messages happened to be
// last at a 2s poll boundary. Anything that arrived and was superseded inside
// one tick was never counted: a build task that finished quickly reported 2 in /
// 56 out while a long one reported 1457 / 22943 from identical code.
describe('recordUsage', () => {
  const assistant = (id: string, input: number, output: number, cacheRead = 0) => ({
    info: { id, role: 'assistant', tokens: { input, output, cache: { read: cacheRead } } },
  });

  it('records every assistant message, not just the last', () => {
    const agg = new TokenAggregator();
    recordUsage(agg, 's1', [
      assistant('m1', 2, 500),
      assistant('m2', 2, 1200),
      assistant('m3', 2, 800),
    ]);

    const t = agg.totals();
    expect(t.tokensOut).toBe(2500);
    expect(t.tokensIn).toBe(6);
  });

  it('is idempotent across polls that re-read the whole transcript', () => {
    const agg = new TokenAggregator();
    const msgs = [assistant('m1', 2, 500), assistant('m2', 2, 1200)];
    recordUsage(agg, 's1', msgs);
    recordUsage(agg, 's1', msgs);
    recordUsage(agg, 's1', msgs);

    expect(agg.totals().tokensOut).toBe(1700);
  });

  it('takes the final counts of a message still streaming across polls', () => {
    const agg = new TokenAggregator();
    recordUsage(agg, 's1', [assistant('m1', 2, 100)]);
    recordUsage(agg, 's1', [assistant('m1', 2, 900)]);

    expect(agg.totals().tokensOut).toBe(900);
  });

  it('skips user messages and messages carrying no usage', () => {
    const agg = new TokenAggregator();
    recordUsage(agg, 's1', [
      { info: { id: 'u1', role: 'user', tokens: { input: 999, output: 999 } } },
      { info: { id: 'm1', role: 'assistant' } },
      assistant('m2', 2, 40),
    ]);

    const t = agg.totals();
    expect(t.tokensOut).toBe(40);
    expect(t.tokensIn).toBe(2);
  });

  it('accumulates cache reads across messages', () => {
    const agg = new TokenAggregator();
    recordUsage(agg, 's1', [assistant('m1', 2, 10, 23_693), assistant('m2', 2, 20, 47_320)]);

    expect(agg.totals().tokensCacheRead).toBe(71_013);
  });

  it('keeps id-less messages distinct rather than collapsing them', () => {
    const agg = new TokenAggregator();
    recordUsage(agg, 's1', [
      { info: { role: 'assistant', tokens: { input: 2, output: 10 } } },
      { info: { role: 'assistant', tokens: { input: 2, output: 30 } } },
    ]);

    expect(agg.totals().tokensOut).toBe(40);
  });
});

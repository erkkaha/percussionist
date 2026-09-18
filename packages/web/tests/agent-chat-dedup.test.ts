// agent-chat-dedup.test.ts — agent chat bubble matching (chat-utils.findBubbleIndex).
//
// The same assistant turn reaches the panel through two paths: the SSE
// stream (under its opencode id, possibly first as partial text) and the
// POST /chat response (final text, with the id when the manager could resolve
// it). findBubbleIndex decides which existing bubble each copy lands in so a
// reply never renders twice, and so a streamed partial is upgraded in place
// rather than left beside a second full copy.

import { describe, expect, it } from 'bun:test';
import { findBubbleIndex } from '../src/client/lib/chat-utils';

type Msg = Parameters<typeof findBubbleIndex>[1];

const user = (text: string, id = 'client-1'): Msg => ({ role: 'user', text, id, completed: true });

describe('findBubbleIndex', () => {
  it('matches a streamed message to the bubble with the same server id', () => {
    const items: Msg[] = [
      user('hi'),
      { role: 'assistant', text: 'part', id: 'a1', completed: false },
    ];
    expect(findBubbleIndex(items, { role: 'assistant', text: 'partial', id: 'a1' })).toBe(1);
  });

  it('adopts a synthetic bubble with identical text when the server id first arrives', () => {
    const items: Msg[] = [
      user('hi'),
      { role: 'assistant', text: 'answer', id: 'client-2', completed: true },
    ];
    expect(findBubbleIndex(items, { role: 'assistant', text: 'answer', id: 'a1' })).toBe(1);
  });

  it('never adopts a history bubble for a different, new reply', () => {
    const items: Msg[] = [
      { role: 'assistant', text: 'old reply', id: 'hist-0-assistant', completed: true },
    ];
    expect(findBubbleIndex(items, { role: 'assistant', text: 'new reply', id: 'a9' })).toBe(-1);
  });

  it('lands an id-less POST reply in the bubble the stream is still filling', () => {
    const items: Msg[] = [
      user('hi'),
      { role: 'assistant', text: 'I will look', id: 'a1', completed: false },
    ];
    expect(findBubbleIndex(items, { role: 'assistant', text: 'I will look it up.' })).toBe(1);
  });

  it('does not attach an id-less POST reply to an already completed streamed turn', () => {
    const items: Msg[] = [
      user('hi'),
      { role: 'assistant', text: 'earlier answer', id: 'a1', completed: true },
    ];
    expect(findBubbleIndex(items, { role: 'assistant', text: 'fresh answer' })).toBe(-1);
  });

  it('refreshes a completed streamed turn when the POST reply carries identical text', () => {
    const items: Msg[] = [
      user('hi'),
      { role: 'assistant', text: 'same answer', id: 'a1', completed: true },
    ];
    expect(findBubbleIndex(items, { role: 'assistant', text: 'same answer' })).toBe(1);
  });

  it('lets identical user text render twice', () => {
    const items: Msg[] = [user('yes', 'client-1')];
    expect(findBubbleIndex(items, { role: 'user', text: 'yes' })).toBe(-1);
  });
});

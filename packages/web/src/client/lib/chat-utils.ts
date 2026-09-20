// chat-utils.ts — utilities for parsing structured content in agent chat messages
// and for matching the copies of a reply that reach the panel by different paths.

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  id?: string;
  created?: number;
  /** `false` while the SSE stream is still delivering this turn's text. */
  completed?: boolean;
}

// Monotonically increasing sequence for messages that carry no server `id`
// (optimistic user bubbles, system/error bubbles, POST-response text). A fresh
// key per message lets identical text render more than once ("yes" twice).
let _clientSeq = 0;

// Stable per-message identity: keep the server `id` when one is supplied,
// otherwise assign a unique client sequence key.
export function stableKey(m: ChatMessage): string {
  return m.id ?? `client-${++_clientSeq}`;
}

// Synthetic keys are the ones we assign locally (`client-*` for live messages,
// `hist-*` for loaded history); everything else is a real server id.
function isSyntheticKey(id: string | undefined): boolean {
  return id == null || id.startsWith('client-') || id.startsWith('hist-');
}

// Index of the last item satisfying the predicate, or -1. Matching the last
// (newest) occurrence keeps an SSE upgrade from hijacking an older history
// bubble with identical text.
function lastIndexMatching(items: ChatMessage[], pred: (m: ChatMessage) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (m && pred(m)) return i;
  }
  return -1;
}

// The same assistant turn reaches the panel twice: the SSE stream delivers it
// under its opencode id (possibly first as partial text, then again complete),
// and the POST /chat response delivers the final text (with the id when the
// manager could resolve it). Pick the bubble both copies should land in, or -1
// to append a new one.
export function findBubbleIndex(items: ChatMessage[], msg: ChatMessage): number {
  if (msg.id != null) {
    const byId = lastIndexMatching(items, (m) => m.id === msg.id);
    if (byId !== -1) return byId;
    // Same text already shown under a locally assigned key (history or the
    // POST response): adopt that bubble instead of duplicating it.
    return lastIndexMatching(
      items,
      (m) => m.role === msg.role && m.text === msg.text && isSyntheticKey(m.id),
    );
  }
  if (msg.role === 'assistant') {
    // POST response without an id: the turn it answers is the newest assistant
    // bubble the stream is still filling in (completed === false), if any.
    const streaming = lastIndexMatching(
      items,
      (m) => m.role === 'assistant' && !isSyntheticKey(m.id),
    );
    const candidate = streaming !== -1 ? items[streaming] : undefined;
    if (candidate && candidate.completed === false) return streaming;
  }
  // Identical text already delivered under a real id: refresh it in place.
  return lastIndexMatching(
    items,
    (m) => m.role === msg.role && m.text === msg.text && !isSyntheticKey(m.id),
  );
}

/** An option definition extracted from an [!option ...] tag */
export interface OptionDef {
  key: string;
  label: string;
  description?: string;
}

/**
 * Parse [!options] blocks from agent message text.
 *
 * Extracts structured option definitions from:
 *   [!options]
 *   [!option key="x" label="y" description="z"]
 *   [/!options]
 *
 * Returns the parsed options and text with successfully parsed blocks removed.
 * Malformed blocks are left as-is (raw tags visible) for graceful degradation.
 */
export function parseOptionBlocks(text: string): { options: OptionDef[]; cleanText: string } {
  const options: OptionDef[] = [];

  // Pattern to match [!options]...[/!options] blocks
  const blockRegex = /\[!options\]([\s\S]*?)\[\/!options\]/g;

  let cleanText = text;
  for (let match = blockRegex.exec(text); match !== null; match = blockRegex.exec(text)) {
    const blockContent = match[1];
    if (!blockContent) continue;

    // Parse individual [!option ...] lines within the block
    const optionLines = blockContent.split('\n').map((line) => line.trim());

    for (const line of optionLines) {
      if (!line.startsWith('[!option ')) continue;

      const parsed = parseOptionLine(line);
      if (parsed) {
        options.push(parsed);
      }
    }

    // Remove this successfully parsed block from cleanText
    cleanText = cleanText.replace(match[0], '');
  }

  return { options, cleanText };
}

/**
 * Parse a single [!option key="x" label="y" description="z"] line.
 *
 * Extracts quoted attributes. Returns null if required attributes (key/label)
 * are missing or malformed.
 */
function parseOptionLine(line: string): OptionDef | null {
  // Expected format: [!option key="value" label="value" description="value"]

  const result: Partial<OptionDef> = {};

  // Match quoted attribute patterns: key="value"
  const attrRegex = /(\w+)="([^"]*)"/g;
  for (let attrMatch = attrRegex.exec(line); attrMatch !== null; attrMatch = attrRegex.exec(line)) {
    const [, key, value] = attrMatch;
    if (key === 'key' || key === 'label' || key === 'description') {
      result[key as keyof OptionDef] = value;
    }
  }

  // Validate required attributes
  if (!result.key || !result.label) {
    return null; // Malformed, leave raw
  }

  return {
    key: result.key,
    label: result.label,
    description: result.description,
  };
}

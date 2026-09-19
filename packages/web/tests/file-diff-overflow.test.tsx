// file-diff-overflow.test.tsx — long file paths must not widen the FileDiff card.
//
// Regression guard for the board UI overflow fix (BUILD-1): a `flex-1` item
// with the default `min-width: auto` refuses to shrink below the min-content
// width of an unbreakable file path, so the card grew past its column. The card
// root, header, and path label now carry `min-w-0`/`max-w-full` so the header
// path ellipsizes (with a `title` fallback), and the unmapped-finding anchor
// path wraps with `break-all` instead of forcing the card wider.
//
// FileDiff is kept REAL here (no module mocks) — it imports react-diff-view's
// global stylesheet, which the existing session suites already exercise. Runs
// under `bun test --isolate`, so nothing leaks into other suites.

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { FileDiff } from '../src/client/components/FileDiff';
import type { TaskDiffFinding } from '../src/client/lib/types';

const BASE_SHA = 'base0000000000000000000000000000000000000';
const HEAD_SHA = 'head0000000000000000000000000000000000000';
const FORK_SHA = 'fork0000000000000000000000000000000000000';

// Far longer than any panel column can fit (~210 chars) so the header label must
// ellipsize rather than set a large min-content width on the card.
const LONG_PATH = `src/${'nested/'.repeat(25)}VeryLongComponentFileName.tsx`;

const SAMPLE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number): number {
-  return a + b;
+  return a - b;
 }
`;

// The anchor path matches the rendered file path so FileDiff associates the
// finding with this card, but the line is far outside the hunk, which forces the
// unmapped-findings block where the raw anchor path is rendered.
function makeUnmappedFinding(): TaskDiffFinding {
  return {
    id: 'finding-1',
    source: 'reviewer',
    severity: 'high',
    title: 'Long-path finding',
    comment: 'A finding anchored outside the diff hunk so it renders unmapped.',
    anchors: [{ path: LONG_PATH, side: 'new', line: 900 }],
    context: {
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      forkSha: FORK_SHA,
      diffFingerprint: 'fingerprint',
    },
    createdAt: '2026-01-01T00:00:00Z',
    isActive: true,
    isStale: false,
  };
}

function renderFileDiff() {
  return render(
    React.createElement(FileDiff, {
      filename: 'VeryLongComponentFileName.tsx',
      path: LONG_PATH,
      diff: SAMPLE_DIFF,
      findings: [makeUnmappedFinding()],
    }),
  );
}

describe('FileDiff long-path overflow', () => {
  afterEach(cleanup);

  it('constrains the card and ellipsizes the header path with a title fallback', () => {
    const { container } = renderFileDiff();

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('min-w-0');
    expect(card.className).toContain('max-w-full');

    const headerPath = card.querySelector('button span.truncate') as HTMLElement;
    expect(headerPath.textContent).toBe(LONG_PATH);
    expect(headerPath.className).toContain('min-w-0');
    expect(headerPath.className).toContain('truncate');
    expect(headerPath.getAttribute('title')).toBe(LONG_PATH);
  });

  it('wraps the unmapped anchor path with break-all', () => {
    const { container } = renderFileDiff();

    // Expand the card so the unmapped-findings block renders.
    const headerButton = container.querySelector('button') as HTMLElement;
    fireEvent.click(headerButton);

    const anchorPath = container.querySelector('p.break-all') as HTMLElement;
    expect(anchorPath).not.toBeNull();
    expect(anchorPath.className).toContain('break-all');
    expect(anchorPath.textContent).toContain(LONG_PATH);
    expect(anchorPath.getAttribute('title')).toBe(`${LONG_PATH}:new:900`);
  });
});

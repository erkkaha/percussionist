// filter-bar-wrap.test.tsx — FilterBar chips must wrap instead of spilling.
//
// Regression guard for the board UI overflow fix (BUILD-3): when the task-list
// column is narrowed by the open detail panel, the type and priority chip
// groups could not wrap internally and their single-line width pushed the chips
// under the detail panel. The groups now carry `flex-wrap` and the outer
// search/chip row is allowed to shrink (`min-w-0`).
//
// Pure component test — no BoardView/module mocking. Runs under
// `bun test --isolate`.

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { FilterBar, type FilterState } from '../src/client/components/board/FilterBar';

const FILTERS: FilterState = { column: 'all', search: '', type: 'all', priority: 'all' };

function renderFilterBar() {
  return render(
    React.createElement(FilterBar, {
      filters: FILTERS,
      onChange: () => {},
      columnCounts: { backlog: 1, ready: 2 },
    }),
  );
}

describe('FilterBar chip wrapping', () => {
  afterEach(cleanup);

  it('lets the type and priority chip groups wrap', () => {
    renderFilterBar();

    const typeGroup = screen.getByRole('button', { name: 'Any type' }).parentElement as HTMLElement;
    expect(typeGroup.className).toContain('flex-wrap');

    const priorityGroup = screen.getByRole('button', { name: 'Any priority' })
      .parentElement as HTMLElement;
    expect(priorityGroup.className).toContain('flex-wrap');
  });

  it('keeps the outer search/chip row shrinkable and wrapping', () => {
    renderFilterBar();

    const searchWrapper = screen.getByPlaceholderText('Search tasks…').parentElement as HTMLElement;
    const chipRow = searchWrapper.parentElement as HTMLElement;
    expect(chipRow.className).toContain('flex-wrap');
    expect(chipRow.className).toContain('min-w-0');
  });
});

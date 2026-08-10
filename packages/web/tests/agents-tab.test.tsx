// agents-tab.test.tsx — Component tests for the project settings Agents tab.
//
// Covers the roster UI that moved out of the Advanced tab: rendering roster
// rows (name + per-row model input), adding an agent via the ClusterAgent
// picker, removing a row, and the per-row ModelSelector. The Radix-based
// `ui/select` is mocked as a functional button list so the picker can be
// driven without Radix portals, and `useProviders` is mocked to an error so
// ModelSelector degrades to a plain text input (its documented fallback).
//
// Uses @testing-library/react with happy-dom (tests/setup.ts). Follows the
// board-header.test.tsx mocking pattern: module mocks at the top of the file,
// component imported dynamically after the mocks take effect.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Module mocks — intercept imports at the module resolution level.
// ---------------------------------------------------------------------------

// Mock the Radix Select as a functional picker: SelectItem renders a button
// that calls onValueChange with its value, so tests can add roster agents
// without driving Radix portals.
mock.module(path.resolve('src/client/components/ui/select'), () => {
  const r = require('react');
  const SelectContext = r.createContext({ value: '', onValueChange: (_v: string) => {} });
  const Select = ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => r.createElement(SelectContext.Provider, { value: { value, onValueChange } }, children);
  const SelectTrigger = ({ children }: { children: React.ReactNode }) =>
    r.createElement('div', null, children);
  const SelectValue = ({ placeholder }: { placeholder?: string }) =>
    r.createElement('span', null, placeholder ?? '');
  const SelectContent = ({ children }: { children: React.ReactNode }) =>
    r.createElement('div', null, children);
  const SelectItem = ({ children, value }: { children: React.ReactNode; value: string }) => {
    const ctx = r.useContext(SelectContext);
    return r.createElement(
      'button',
      { type: 'button', onClick: () => ctx.onValueChange(value) },
      children,
    );
  };
  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

// Make ModelSelector degrade to its plain-text-input fallback (providers
// endpoint unreachable), so each roster row renders a bare model input.
mock.module(path.resolve('src/client/hooks/useProviders'), () => ({
  useProviders: () => ({ data: undefined, isLoading: false, isError: true }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLUSTER_AGENTS = [
  { name: 'builder', content: 'Implements BUILD tasks.', model: 'anthropic/claude-sonnet-4' },
  { name: 'reviewer', content: 'Reviews BUILD output.' },
  { name: 'planner', content: 'Produces implementation plans.', model: 'openai/gpt-4o' },
];

async function renderTab(props: Record<string, unknown> = {}) {
  const { default: AgentsTab } = await import('../src/client/components/project-form/AgentsTab');
  return render(
    React.createElement(AgentsTab, {
      form: {
        rosterAgents: [
          { name: 'builder', model: 'anthropic/claude-sonnet-4' },
          { name: 'reviewer', model: '' },
        ],
        rosterPickerValue: '',
        setRosterPickerValue: () => {},
        setRosterAgents: () => {},
        addRosterAgent: () => {},
        updateRosterAgentModel: () => {},
      },
      clusterAgents: CLUSTER_AGENTS,
      ...props,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentsTab', () => {
  afterEach(cleanup);

  it('renders a roster row per agent with a model input', async () => {
    await renderTab();

    // Agent names render in mono rows
    expect(screen.getByText('builder')).toBeTruthy();
    expect(screen.getByText('reviewer')).toBeTruthy();

    // One model input per row, prefilled from the roster state
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(inputs.length).toBe(2);
    expect(inputs[0]?.value).toBe('anthropic/claude-sonnet-4');
    expect(inputs[1]?.value).toBe('');
  });

  it('only offers non-roster ClusterAgents in the picker', async () => {
    await renderTab();

    // builder and reviewer are already in the roster, so only planner is offered
    expect(screen.getByRole('button', { name: 'planner' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'builder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'reviewer' })).toBeNull();
  });

  it('adds an agent via the picker', async () => {
    const addRosterAgent = mock(() => {});
    await renderTab({
      form: {
        rosterAgents: [{ name: 'builder', model: '' }],
        rosterPickerValue: '',
        setRosterPickerValue: () => {},
        setRosterAgents: () => {},
        addRosterAgent,
        updateRosterAgentModel: () => {},
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'planner' }));

    expect(addRosterAgent).toHaveBeenCalledWith('planner');
  });

  it('removes a roster row by name', async () => {
    const setRosterAgents = mock(() => {});
    await renderTab({
      form: {
        rosterAgents: [
          { name: 'builder', model: '' },
          { name: 'reviewer', model: '' },
        ],
        rosterPickerValue: '',
        setRosterPickerValue: () => {},
        setRosterAgents,
        addRosterAgent: () => {},
        updateRosterAgentModel: () => {},
      },
    });

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    expect(removeButtons.length).toBeGreaterThan(0);
    fireEvent.click(removeButtons[0] as HTMLElement);

    expect(setRosterAgents).toHaveBeenCalled();
    const updater = setRosterAgents.mock.calls[0]?.[0] as (prev: unknown[]) => unknown[];
    expect(
      updater([
        { name: 'builder', model: '' },
        { name: 'reviewer', model: '' },
      ]),
    ).toEqual([{ name: 'reviewer', model: '' }]);
  });

  it('updates the row model when typed into the ModelSelector input', async () => {
    const updateRosterAgentModel = mock(() => {});
    await renderTab({
      form: {
        rosterAgents: [{ name: 'builder', model: '' }],
        rosterPickerValue: '',
        setRosterPickerValue: () => {},
        setRosterAgents: () => {},
        addRosterAgent: () => {},
        updateRosterAgentModel,
      },
    });

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'anthropic/claude-sonnet-4' } });

    expect(updateRosterAgentModel).toHaveBeenCalledWith('builder', 'anthropic/claude-sonnet-4');
  });

  it('shows the ClusterAgent model as a muted hint when the row model is empty', async () => {
    await renderTab();

    // reviewer has no row model; its ClusterAgent has no model either → generic default copy
    expect(screen.getByText(/default — falls back to the ClusterAgent model/)).toBeTruthy();
  });

  it('shows the ClusterAgent configured model for an empty row model when known', async () => {
    await renderTab({
      form: {
        rosterAgents: [{ name: 'planner', model: '' }],
        rosterPickerValue: '',
        setRosterPickerValue: () => {},
        setRosterAgents: () => {},
        addRosterAgent: () => {},
        updateRosterAgentModel: () => {},
      },
    });

    // planner's ClusterAgent declares model openai/gpt-4o → shown as fallback hint
    expect(screen.getByText(/ClusterAgent model/)).toBeTruthy();
    expect(screen.getByText('openai/gpt-4o')).toBeTruthy();
  });
});

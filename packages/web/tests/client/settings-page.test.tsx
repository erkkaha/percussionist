// settings-page.test.tsx — Provider Secrets panel key/value row editing.
//
// Verifies the Settings "Provider Secrets" panel renders editable key/value
// rows, masks values with password inputs, and assembles a non-empty `data`
// object when creating/updating a Secret (so the server no longer rejects with
// 400 on an empty {}).
//
// Uses @testing-library/react with happy-dom (tests/setup.ts). The `api`
// module is mocked so the panel's queries resolve with controlled data and we
// can record the secret mutation calls without hitting the network. The
// component is wrapped in MemoryRouter + QueryClientProvider for router /
// react-query context.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Module mocks — intercept imports at the module resolution level
// ---------------------------------------------------------------------------

// Captured mutation calls (no `mock.fn` in this Bun version — plain recorders).
const updateSecretCalls: Array<{ name: string; data: Record<string, string> }> = [];
const createSecretCalls: Array<{ name: string; data: Record<string, string> }> = [];
const deleteSecretCalls: string[] = [];

mock.module(path.resolve('src/client/lib/api'), () => ({
  fetchSettings: async () => ({
    spec: { secrets: { llmKeysSecret: 'llm-keys' } },
  }),
  fetchOpencodeConfig: async () => '',
  listSecrets: async () => ({
    items: [{ name: 'llm-keys', keys: ['ANTHROPIC_API_KEY'] }],
  }),
  fetchUpdateStatus: async () => ({
    current: { operator: null, manager: null, web: null, dispatcher: null },
    latest: null,
    updateAvailable: false,
  }),
  createSecret: async (name: string, data: Record<string, string>) => {
    createSecretCalls.push({ name, data });
  },
  updateSecret: async (name: string, data: Record<string, string>) => {
    updateSecretCalls.push({ name, data });
  },
  deleteSecret: async (name: string) => {
    deleteSecretCalls.push(name);
  },
  saveSettings: async () => ({}),
  postUpgradeApply: async () => ({ patched: [], errors: [], targetTag: 'x' }),
}));

// Mock Button as a native <button> to avoid radix Slot / cva complexity.
mock.module(path.resolve('src/client/components/ui/button'), () => ({
  Button: 'button',
}));

// SettingsPage statically imports its sibling panels (AgentsPage, ProjectsPage,
// ModelSelector, NotificationsPanel). Some of those transitively import modules
// using the `@/` path alias, which bun does not resolve under `bun test`. The
// secrets panel under test does not render them, so stub them out to keep the
// import graph on relative-path modules only.
const SIBLING_PANELS = [
  'src/client/components/AgentsPage',
  'src/client/components/ProjectsPage',
  'src/client/components/ModelSelector',
  'src/client/components/NotificationsPanel',
];
for (const p of SIBLING_PANELS) {
  mock.module(path.resolve(p), () => ({ default: () => null }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  updateSecretCalls.length = 0;
  createSecretCalls.length = 0;
  deleteSecretCalls.length = 0;
}

async function renderSettingsSecrets() {
  const { MemoryRouter } = await import('react-router-dom');
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const { default: SettingsPage } = await import('../../src/client/components/SettingsPage');
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/settings?tab=secrets'] },
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(SettingsPage),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Settings Provider Secrets panel', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('renders the secrets panel with provider secret name inputs', async () => {
    await renderSettingsSecrets();
    expect(await screen.findByText('Provider API Keys')).toBeTruthy();
    // LLM-keys secret name input is pre-populated from settings spec.
    expect(screen.getByDisplayValue('llm-keys')).toBeTruthy();
  });

  it('has no rows initially and the Update button is disabled until a valid row exists', async () => {
    await renderSettingsSecrets();
    await screen.findByText('Provider API Keys');

    // No key/value inputs before a row is added.
    expect(screen.queryByLabelText('Key')).toBeNull();
    expect(screen.queryByLabelText('Value')).toBeNull();

    // The existing-secret Update button is disabled while there are no valid rows.
    const updateBtn = screen.getByText('Update Secret');
    expect(updateBtn).toBeDisabled();
  });

  it('adds a key/value row, masks the value, and updates the Secret with assembled data', async () => {
    await renderSettingsSecrets();
    await screen.findByText('Provider API Keys');

    // Add a row to the LLM-keys editor (first "Add key" button — auth is second).
    const addButtons = screen.getAllByText('Add key');
    fireEvent.click(addButtons[0]);

    const keyInput = screen.getByLabelText('Key') as HTMLInputElement;
    const valueInput = screen.getByLabelText('Value') as HTMLInputElement;
    expect(keyInput).toBeTruthy();
    // Value must be masked.
    expect(valueInput.type).toBe('password');

    fireEvent.change(keyInput, { target: { value: 'OPENAI_API_KEY' } });
    fireEvent.change(valueInput, { target: { value: 'sk-secret-123' } });

    // A valid row enables the Update button.
    const updateBtn = screen.getByText('Update Secret') as HTMLButtonElement;
    expect(updateBtn.disabled).toBe(false);

    fireEvent.click(updateBtn);

    // secretMutation forwards the assembled data (not {}) to updateSecret.
    await waitFor(() =>
      expect(updateSecretCalls).toEqual([
        { name: 'llm-keys', data: { OPENAI_API_KEY: 'sk-secret-123' } },
      ]),
    );
  });

  it('builds data only from rows with both a key and value', async () => {
    await renderSettingsSecrets();
    await screen.findByText('Provider API Keys');

    fireEvent.click(screen.getAllByText('Add key')[0]);
    const keyInput = screen.getByLabelText('Key') as HTMLInputElement;
    const valueInput = screen.getByLabelText('Value') as HTMLInputElement;

    // Key with empty value must NOT trigger a mutation.
    fireEvent.change(keyInput, { target: { value: 'ORPHAN_KEY' } });
    fireEvent.change(valueInput, { target: { value: '   ' } });

    fireEvent.click(screen.getByText('Update Secret'));
    // Give any pending mutation a chance to run, then assert it did not.
    await new Promise((r) => setTimeout(r, 50));
    expect(updateSecretCalls.length).toBe(0);

    // Now fill a valid value; the button becomes enabled and submits.
    fireEvent.change(valueInput, { target: { value: 'real-value' } });
    fireEvent.click(screen.getByText('Update Secret'));

    await waitFor(() =>
      expect(updateSecretCalls).toEqual([{ name: 'llm-keys', data: { ORPHAN_KEY: 'real-value' } }]),
    );
  });

  it('removes a row when the remove button is clicked', async () => {
    await renderSettingsSecrets();
    await screen.findByText('Provider API Keys');

    fireEvent.click(screen.getAllByText('Add key')[0]);
    expect(screen.getByLabelText('Key')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Remove key'));
    expect(screen.queryByLabelText('Key')).toBeNull();
  });
});

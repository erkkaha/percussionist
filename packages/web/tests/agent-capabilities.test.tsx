import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AgentCapabilitySchema } from '../../api/src/index.js';
import {
  AGENT_CAPABILITIES,
  AGENT_CAPABILITY_METADATA,
} from '../src/client/lib/agent-capabilities.js';

describe('agent capability metadata', () => {
  it('covers every AgentCapability enum value in shared metadata', () => {
    const expectedCapabilities = new Set(AgentCapabilitySchema.options);
    const metadataKeys = new Set(Object.keys(AGENT_CAPABILITY_METADATA));

    expect(metadataKeys).toEqual(expectedCapabilities);
    expect(AGENT_CAPABILITIES).toHaveLength(expectedCapabilities.size);
  });

  it('has non-empty descriptions for all capabilities', () => {
    for (const capability of AGENT_CAPABILITIES) {
      expect(capability.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('AgentForm capability helper text rendering', () => {
  it('uses shared metadata and renders helper description text in capability rows', () => {
    const source = readFileSync(
      new URL('../src/client/components/AgentForm.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('AGENT_CAPABILITIES.map((capability) =>');
    expect(source).toContain('{capability.description}');

    for (const capability of AGENT_CAPABILITIES) {
      expect(capability.description.trim().length).toBeGreaterThan(0);
    }
  });
});

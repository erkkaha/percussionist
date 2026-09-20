// slash-commands.test.ts — the run terminal's pure slash-command registry.
//
// Covers the parser (whitespace tolerance, first-token-only matching, the
// null cases), alias resolution, unknown commands, and the registry metadata
// invariants the command bar and autocomplete menu depend on. No React, no DOM:
// commands.ts is a pure module and must stay importable from anywhere.

import { describe, expect, it } from 'bun:test';
import {
  COMMANDS,
  matchCommands,
  parseSlashInput,
  resolveCommand,
} from '../src/client/components/run-terminal/commands';

describe('parseSlashInput', () => {
  const cases: Array<[label: string, input: string, expected: unknown]> = [
    ['bare command', '/logs', { command: 'logs', args: [], argsText: '', raw: '/logs' }],
    [
      'single argument',
      '/logs engine',
      { command: 'logs', args: ['engine'], argsText: 'engine', raw: '/logs engine' },
    ],
    [
      'multiple arguments',
      '/logs engine --tail 200',
      {
        command: 'logs',
        args: ['engine', '--tail', '200'],
        argsText: 'engine --tail 200',
        raw: '/logs engine --tail 200',
      },
    ],
    [
      'surrounding whitespace',
      '   /status   ',
      { command: 'status', args: [], argsText: '', raw: '   /status   ' },
    ],
    [
      'extra internal whitespace is collapsed into tokens',
      '/logs\t engine \n --tail 200 ',
      {
        command: 'logs',
        args: ['engine', '--tail', '200'],
        argsText: 'engine \n --tail 200',
        raw: '/logs\t engine \n --tail 200 ',
      },
    ],
    [
      'reply keeps the raw argument text verbatim',
      '/reply  hello   world  ',
      {
        command: 'reply',
        args: ['hello', 'world'],
        argsText: 'hello   world',
        raw: '/reply  hello   world  ',
      },
    ],
    [
      'only the first token is matched',
      '/reply /logs engine',
      {
        command: 'reply',
        args: ['/logs', 'engine'],
        argsText: '/logs engine',
        raw: '/reply /logs engine',
      },
    ],
    [
      'case is preserved on the token, matching is up to resolveCommand',
      '/LOG',
      { command: 'LOG', args: [], argsText: '', raw: '/LOG' },
    ],
  ];

  for (const [label, input, expected] of cases) {
    it(`parses ${label}`, () => {
      expect(parseSlashInput(input)).toEqual(expected);
    });
  }

  const nullCases: Array<[label: string, input: string]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a lone slash', '/'],
    ['a slash and trailing whitespace', '/   '],
    ['a plain sentence', 'please continue the task'],
    ['plain text that merely contains a slash', 'see foo/bar'],
    ['a newline-separated plain sentence', 'first line\nsecond line'],
  ];

  for (const [label, input] of nullCases) {
    it(`returns null for ${label}`, () => {
      expect(parseSlashInput(input)).toBeNull();
    });
  }
});

describe('resolveCommand', () => {
  const cases: Array<[label: string, token: string, name: string]> = [
    ['canonical name', 'logs', 'logs'],
    ['canonical name, uppercase', 'LOGS', 'logs'],
    ['surrounding whitespace', '  logs  ', 'logs'],
    ['alias', 'log', 'logs'],
    ['alias, mixed case', 'CoNv', 'conversation'],
    ['question-mark help alias', '?', 'help'],
    ['delete alias for cancel', 'delete', 'cancel'],
    ['terminal alias for shell', 'terminal', 'shell'],
  ];

  for (const [label, token, name] of cases) {
    it(`resolves ${label}`, () => {
      expect(resolveCommand(token)?.name).toBe(name);
    });
  }

  it('returns undefined for an unknown command', () => {
    expect(resolveCommand('frobnicate')).toBeUndefined();
  });

  it('does not accept a leading slash (parseSlashInput strips it)', () => {
    expect(resolveCommand('/logs')).toBeUndefined();
  });

  it('returns undefined for an empty token', () => {
    expect(resolveCommand('')).toBeUndefined();
    expect(resolveCommand('   ')).toBeUndefined();
  });
});

describe('COMMANDS metadata', () => {
  it('has unique, lowercase names', () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toBe(name.toLowerCase());
  });

  it('has aliases that never collide with a name or another alias', () => {
    const names = new Set(COMMANDS.map((command) => command.name));
    const seen = new Set<string>();
    for (const command of COMMANDS) {
      for (const alias of command.aliases ?? []) {
        expect(alias).toBe(alias.toLowerCase());
        expect(names.has(alias)).toBe(false);
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  it('gives every command a usage string beginning with its own name', () => {
    for (const command of COMMANDS) {
      expect(command.usage.length).toBeGreaterThan(0);
      expect(command.usage.startsWith(`/${command.name}`)).toBe(true);
    }
  });

  it('gives every command a description and a valid kind', () => {
    for (const command of COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
      expect(['ui', 'server']).toContain(command.kind);
    }
  });

  it('covers the command set in the plan', () => {
    expect(COMMANDS.map((command) => command.name)).toEqual([
      'help',
      'status',
      'logs',
      'conversation',
      'shell',
      'clear',
      'copy',
      'refresh',
      'stop',
      'start',
      'reply',
      'cancel',
    ]);
    expect(
      COMMANDS.filter((command) => command.kind === 'ui').map((command) => command.name),
    ).toEqual(['help', 'status', 'logs', 'conversation', 'shell', 'clear', 'copy', 'refresh']);
    expect(
      COMMANDS.filter((command) => command.kind === 'server').map((command) => command.name),
    ).toEqual(['stop', 'start', 'reply', 'cancel']);
  });

  it('resolves every declared alias back to its command', () => {
    for (const command of COMMANDS) {
      for (const alias of command.aliases ?? []) {
        expect(resolveCommand(alias)?.name).toBe(command.name);
      }
    }
  });
});

describe('matchCommands', () => {
  it('returns every command for an empty prefix', () => {
    expect(matchCommands('').map((command) => command.name)).toEqual(
      COMMANDS.map((command) => command.name),
    );
  });

  it('prefix-matches names', () => {
    expect(matchCommands('con').map((command) => command.name)).toEqual(['conversation']);
  });

  it('prefix-matches aliases', () => {
    expect(matchCommands('at').map((command) => command.name)).toEqual(['shell']);
    expect(matchCommands('del').map((command) => command.name)).toEqual(['cancel']);
  });

  it('is case-insensitive and returns nothing for an unknown prefix', () => {
    expect(matchCommands('LOG').map((command) => command.name)).toEqual(['logs']);
    expect(matchCommands('zzz')).toEqual([]);
  });
});

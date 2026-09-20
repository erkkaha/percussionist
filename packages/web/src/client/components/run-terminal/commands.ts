// Slash-command registry and parser for the run page's terminal command bar.
//
// This module is deliberately pure: no React, no fetch, no view state. It only
// knows the shape of a command and how to split a raw input line into a command
// token plus arguments. Execution lives in the shell / command bar so the
// registry can be table-tested in isolation.
//
// The command surface is the run terminal's prompt, not the raw xterm attach:
// once `/shell` attaches a PTY the browser forwards keystrokes and can no longer
// intercept a leading `/`. `/help` states this so the behavior is not read as a
// bug.

export type CommandKind = 'ui' | 'server';

/**
 * The run page's stage, mirrored by the `?view=` search param. `conversation` is
 * the default; the others are reachable by slash command (and deep link).
 */
export type RunView = 'conversation' | 'logs' | 'status' | 'shell';

export interface SlashCommand {
  /** Bare command token, lowercase, without the leading slash. */
  name: string;
  /** Alternate tokens that resolve to the same command, lowercase, no slash. */
  aliases?: string[];
  /** Canonical usage line shown by `/help` and the autocomplete menu. */
  usage: string;
  /** One-line explanation shown by `/help` and the autocomplete menu. */
  description: string;
  /** `ui` commands mutate local view state; `server` commands call the API. */
  kind: CommandKind;
  /** Optional hint for the argument list, e.g. `[container]`. */
  argsHint?: string;
}

export interface ParsedCommand {
  /** Command token with the leading slash removed, preserving its case. */
  command: string;
  /** Whitespace-separated argument tokens after the command. */
  args: string[];
  /**
   * The raw remainder after the command token with only leading/trailing
   * whitespace trimmed. Internal whitespace is preserved so `/reply` can send
   * the user's message verbatim.
   */
  argsText: string;
  /** The original input line, unmodified. */
  raw: string;
}

/**
 * The full slash-command set. Order is the `/help` listing order.
 */
export const COMMANDS: readonly SlashCommand[] = [
  {
    name: 'help',
    aliases: ['?'],
    usage: '/help',
    description: 'List the slash commands',
    kind: 'ui',
  },
  {
    name: 'status',
    usage: '/status',
    description: 'Show the run status panel',
    kind: 'ui',
  },
  {
    name: 'logs',
    aliases: ['log'],
    usage: '/logs [container]',
    description: 'Show pod logs',
    kind: 'ui',
    argsHint: '[container]',
  },
  {
    name: 'conversation',
    aliases: ['chat', 'conv', 'back'],
    usage: '/conversation',
    description: 'Show the agent conversation',
    kind: 'ui',
  },
  {
    name: 'shell',
    aliases: ['attach', 'terminal'],
    usage: '/shell',
    description: 'Attach an interactive TTY (opencode, running pod only)',
    kind: 'ui',
  },
  {
    name: 'clear',
    usage: '/clear',
    description: 'Clear the local command output (not the conversation)',
    kind: 'ui',
  },
  {
    name: 'copy',
    usage: '/copy',
    description: 'Copy the run name to the clipboard',
    kind: 'ui',
  },
  {
    name: 'refresh',
    usage: '/refresh',
    description: 'Refresh the run, session and log data',
    kind: 'ui',
  },
  {
    name: 'stop',
    usage: '/stop',
    description: 'Stop the agent’s current turn; the session stays open',
    kind: 'server',
  },
  {
    name: 'start',
    usage: '/start',
    description: 'Start the session of an interactive run',
    kind: 'server',
  },
  {
    name: 'reply',
    usage: '/reply <text>',
    description: 'Send a message to the agent (same as typing plain text)',
    kind: 'server',
    argsHint: '<text>',
  },
  {
    name: 'cancel',
    aliases: ['delete'],
    usage: '/cancel',
    description: 'Delete the run after a confirmation',
    kind: 'server',
  },
] as const;

/**
 * Split a raw input line into a command token and its arguments.
 *
 * Returns `null` for anything that is not a slash command: empty or whitespace-
 * only input, a lone `/`, or a plain sentence with no leading slash. Matching
 * only ever looks at the first token, so `/reply /logs` is a reply whose text is
 * literally `/logs`, not a nested command.
 */
export function parseSlashInput(input: string): ParsedCommand | null {
  if (typeof input !== 'string') return null;
  const raw = input;
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const body = trimmed.slice(1);
  // A lone '/' is not a command — the caller falls back to sending it as reply
  // text.
  if (body.length === 0) return null;

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return null;

  const command = match[1] ?? '';
  if (command.length === 0) return null;

  const argsText = (match[2] ?? '').trim();
  const args = argsText.length > 0 ? argsText.split(/\s+/) : [];

  return { command, args, argsText, raw };
}

/**
 * Resolve a bare command token (no leading slash) to its definition. Case-
 * insensitive and tolerant of surrounding whitespace. Returns `undefined` for an
 * unknown token — callers print `unknown command` and never forward it.
 */
export function resolveCommand(name: string): SlashCommand | undefined {
  if (typeof name !== 'string') return undefined;
  const token = name.trim().toLowerCase();
  if (token.length === 0) return undefined;
  return COMMANDS.find(
    (command) => command.name === token || (command.aliases?.includes(token) ?? false),
  );
}

/**
 * Commands whose name or an alias starts with the given prefix, for the command
 * bar's autocomplete menu. Passing an empty prefix returns every command.
 */
export function matchCommands(prefix: string): SlashCommand[] {
  const token = typeof prefix === 'string' ? prefix.trim().toLowerCase() : '';
  if (token.length === 0) return [...COMMANDS];
  return COMMANDS.filter(
    (command) =>
      command.name.startsWith(token) ||
      (command.aliases?.some((alias) => alias.startsWith(token)) ?? false),
  );
}

// agent/security.ts — Security utilities for workspace tooling.
//
// Provides input validation and sanitization for commands executed in
// workspace maintenance pods, preventing shell-injection attacks via
// untrusted inputs (e.g., package names, user-supplied commands).

// ---------------------------------------------------------------------------
// Alpine package name validation
//
// Valid Alpine package names match: [a-zA-Z0-9._+-]+
// See: https://wiki.alpinelinux.org/wiki/Apk_specification
const ALPINE_PACKAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+\-]*$/;

/**
 * Validate an Alpine package name against the allowed character set.
 * Returns `true` if the name is valid, `false` otherwise.
 */
export function isValidPackageName(name: string): boolean {
  return ALPINE_PACKAGE_RE.test(name);
}

// ---------------------------------------------------------------------------
// Shell injection detection for exec_in_workspace commands
//
// The command is passed to `/bin/sh -c`, so any shell metacharacter in the
// input can alter command semantics. We reject known injection patterns
// before the command reaches execInWorkspace().

/**
 * Dangerous shell constructs that indicate potential command injection.
 * Each pattern is tested against the raw command string.
 */
const INJECTION_PATTERNS: RegExp[] = [
  // Command substitution: $(...) or `...`
  /\$\(/,           // $() subshell
  /`[^`]*`/,        // backtick command substitution

  // Pipeline injection: ; | && ||
  /;/,              // semicolon (command separator)
  /\|/,             // pipe
  /&&/,             // AND list
  /\|\|/,           // OR list

  // Backgrounding
  /&\s*$/,          // trailing & for background execution

  // Redirection to sensitive paths or command chaining via >
  />[>&]/,         // output redirection (>, >>)
  /<[>& ]/,        // input redirection (<, <<, < file)

  // Subshell grouping
  /\(/,            // opening paren (subshell/grouping)
  /\)/,            // closing paren

  // Variable assignment as command prefix: FOO=bar cmd
  /^[A-Za-z_][A-Za-z0-9_]*=/m, // env var assignment before command

  // Here-documents
  /<<-?\s*[A-Za-z]/, // here-document redirector

  // Brace expansion (bash-specific but still dangerous)
  /\{[^}]*\}/,      // brace expansion group

  // Process substitution: <(...) or >(...)
  /[<>]\(/,         // process substitution start

  // Globbing that could match unexpected files in sensitive paths
  /\*\*\/|\/\*\//,   // recursive glob patterns

  // Path traversal attempts
  /\.\.[\/]/,       // .. followed by / or \
];

/**
 * Check whether a command string contains shell injection indicators.
 * Returns `null` if the command is safe, or an error message describing
 * what was rejected and why.
 */
export function sanitizeCommand(command: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(command)) {
      return `Command rejected: contains shell metacharacter pattern matching /${pattern.source}/`;
    }
  }

  // Additional check: reject commands that are empty or whitespace-only
  if (!command.trim()) {
    return "Command rejected: empty command";
  }

  // Reject commands that start with a comment (potential obfuscation)
  if (/^\s*#/.test(command)) {
    return "Command rejected: starts with comment character";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Audit logging helper
//
// Logs security-relevant events to the manager's stdout for operational
// visibility. Format follows the existing console.log convention in tools.ts.

export function logSecurityEvent(
  event: string,
  details: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  const detailStr = Object.entries(details)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  console.log(`[security] ${timestamp} ${event} ${detailStr}`);
}

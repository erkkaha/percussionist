// mcp-server.ts — MCP (Model Context Protocol) HTTP server for run-pod agents.
//
// Exposes tools: fail_run, complete_run, complete_plan, complete_merge,
//                get_status, create_task, search_code, write_plan, read_plan, read_session,
//                complete_review
//
// fail_run — the agent calls this to signal that it cannot complete its task.
// The dispatcher detects the call and throws a "session error:" which causes
// the standard failure path: main().catch → patchStatus(Failed).
//
// complete_run — the agent calls this to explicitly signal successful completion
// with a human-readable summary. The orchestrator spawns a success-review
// facilitator that approves or redirects the result before closing the task.
//
// complete_plan — like complete_run but for PLAN tasks; signals plan artifact
// completeness. The orchestrator triggers build-task generation.
//
// complete_merge — like complete_run but for merge runs; submits a structured
// merge verdict (outcome, diagnosis, branches, SHA). The orchestrator uses the
// verdict annotation to decide task transitions.
//
// complete_review — submits a structured review verdict for a completed worker
// run and marks the review run as complete.
//
// get_status — returns the current run state (phase, session ID, tokens, etc.)
// for agent self-awareness without cluster API access.
//
// create_task — creates a new BUILD Task CR from within a run pod.
//
// search_code — searches the workspace with ripgrep or grep.
//
// write_plan / read_plan — persist and retrieve plan artifacts via ConfigMap.
//
// read_session — reads session data from another run's ConfigMap snapshot.
//
// Transport: MCP Streamable HTTP (POST /mcp), JSON-RPC 2.0.
// Port: DISPATCHER_MCP_PORT (4097) — adjacent to opencode's 4096, unlikely
// to conflict with common dev tooling.
//
// Opencode discovers this server via OPENCODE_CONFIG_CONTENT injected by the
// operator into the runner container's environment.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  type AgentCapability,
  DISPATCHER_MCP_PORT,
  type Finding,
  FindingSchema,
  MERGE_VERDICT_ANNOTATION,
  normalizeMergeVerdict,
  normalizeReviewVerdict,
} from '@percussionist/api';
import {
  appendFindingToConfigMap,
  buildTask,
  createTask,
  getClusterAgent,
  getProject,
  getRun,
  getTask,
  patchRunAnnotations,
  patchTaskStatus,
  readAllSessionsFromConfigMap,
  readPlanFromConfigMap,
  validateAgentTaskCapability,
  writePlanToConfigMap,
} from '@percussionist/kube';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'percussionist-dispatcher';
const SERVER_VERSION = '1.0';

const TOOL_FAIL_RUN = {
  name: 'fail_run',
  description:
    'Signal that this agent run has failed and cannot be completed. ' +
    'The orchestrator will trigger facilitator analysis of the failure. ' +
    'Call this instead of stopping silently when you determine the task is impossible.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Human-readable explanation of why the task cannot be completed.',
      },
    },
    required: ['reason'],
  },
};

const TOOL_COMPLETE_RUN = {
  name: 'complete_run',
  description:
    'Signal that this agent run has completed successfully. ' +
    'The orchestrator will trigger a success review by a facilitator agent, ' +
    'which may approve the result or redirect the task to another agent. ' +
    'Call this when you have finished your work and want an explicit review gate ' +
    'rather than relying on silent session completion.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Human-readable summary of what was accomplished.',
      },
    },
    required: ['summary'],
  },
};

const TOOL_COMPLETE_PLAN = {
  name: 'complete_plan',
  description:
    'Signal that this PLAN agent run has completed successfully. ' +
    'Unlike complete_run, this does not require a pull request. ' +
    'The orchestrator will evaluate the plan artifact and generate BUILD tasks. ' +
    'Call this after committing and pushing the plan artifact.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Human-readable summary of what the plan covers.',
      },
    },
    required: ['summary'],
  },
};

const TOOL_COMPLETE_MERGE = {
  name: 'complete_merge',
  description:
    'Submit a structured merge verdict for a merge run and mark the run as complete. ' +
    'Call this from an integrator agent run instead of complete_run. ' +
    'Writes the verdict to the Run annotations so the orchestrator can act on it.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['merged', 'already-merged', 'conflict', 'push-failed', 'transient-failure'],
        description: 'Deterministic merge outcome',
      },
      diagnosis: {
        type: 'string',
        description: '1-2 sentence assessment of the merge result',
      },
      details: {
        type: 'string',
        description: 'Optional detailed context',
      },
      sourceBranch: {
        type: 'string',
        description: 'Optional source branch name',
      },
      targetBranch: {
        type: 'string',
        description: 'Optional target branch name',
      },
      mergeCommitSha: {
        type: 'string',
        description: 'Optional merge commit SHA',
      },
      requiresHuman: {
        type: 'boolean',
        description: 'Whether this outcome requires human intervention',
      },
    },
    required: ['outcome'],
  },
};

const TOOL_COMPLETE_REVIEW = {
  name: 'complete_review',
  description:
    'Submit a structured review verdict for a completed worker run and mark the review run as complete. ' +
    'Call this from a review agent run instead of complete_run. ' +
    'Writes the verdict to the Run annotations so the orchestrator can act on it.',
  inputSchema: {
    type: 'object',
    properties: {
      approved: {
        type: 'boolean',
        description: 'Whether the review approves this work (true=approve, false=request_changes)',
      },
      diagnosis: {
        type: 'string',
        description: '1-2 sentence assessment of whether the worker completed the task',
      },
      feedback: {
        type: 'string',
        description: 'Optional detailed feedback for the worker or human reviewer',
      },
      suggestion: {
        type: 'string',
        description: 'Optional suggestion for how to improve the work',
      },
      findings: {
        type: 'array',
        description:
          'Optional structured diff findings (max 25). Each finding has severity, title, comment, ' +
          '1-3 line anchors, and diff context. Invalid or overflowing findings are dropped; core verdict still writes.',
        maxItems: 25,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique finding ID' },
            severity: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low', 'info'],
            },
            score: { type: 'number', minimum: 0, maximum: 100 },
            title: { type: 'string', maxLength: 160 },
            comment: { type: 'string', maxLength: 2000 },
            category: { type: 'string', maxLength: 64 },
            anchors: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  side: { type: 'string', enum: ['old', 'new'] },
                  line: { type: 'integer', minimum: 1 },
                  endLine: { type: 'integer', minimum: 1 },
                  hunkHeader: { type: 'string', maxLength: 256 },
                },
                required: ['path', 'side', 'line'],
              },
            },
            context: {
              type: 'object',
              properties: {
                baseSha: { type: 'string' },
                headSha: { type: 'string' },
                forkSha: { type: 'string' },
                diffFingerprint: { type: 'string' },
              },
              required: ['baseSha', 'headSha', 'forkSha', 'diffFingerprint'],
            },
            createdAt: { type: 'string' },
            authorRunName: { type: 'string' },
          },
          required: ['id', 'severity', 'title', 'comment', 'anchors', 'context', 'createdAt'],
        },
      },
    },
    required: ['approved', 'diagnosis'],
  },
};

const TOOL_GET_STATUS = {
  name: 'get_status',
  description:
    'Return the current status of this agent run (phase, session ID, token counts). ' +
    'Useful for self-awareness without cluster API access.',
  inputSchema: { type: 'object', properties: {} },
};

const TOOL_CREATE_TASK = {
  name: 'create_task',
  description:
    'Create a new BUILD Task CR for the current project. ' +
    'Starts in pending phase (backlog column). ' +
    "The agent name must be in the project's agent roster. " +
    'Returns the created task name via a taskName field for use with predecessorRef.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short human-readable title for the BUILD task' },
      description: {
        type: 'string',
        description: 'Detailed implementation context and acceptance criteria (optional)',
      },
      agent: { type: 'string', description: "Agent name (must be in project's agent roster)" },
      priority: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Priority (default: medium)',
      },
      predecessorRef: {
        type: 'string',
        description: 'Name of the preceding BUILD task this task depends on (optional)',
      },
    },
    required: ['title', 'agent'],
  },
};

const TOOL_SEARCH_CODE = {
  name: 'search_code',
  description:
    'Search the codebase for a regex or literal pattern. Returns structured matches ' +
    'with file paths, line numbers, and surrounding context. Uses ripgrep (rg) when ' +
    'available, falls back to grep. Results are capped at 200 matches.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search pattern (regex by default, literal when fixedStrings is true)',
      },
      path: { type: 'string', description: 'Subdirectory to search (default: /workspace)' },
      filePattern: {
        type: 'string',
        description: 'Glob pattern to filter files, e.g. *.ts, *.go (optional)',
      },
      contextLines: {
        type: 'number',
        description: 'Lines of context before/after each match (default: 2, max: 10)',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum matches to return (default: 50, max: 200)',
      },
      fixedStrings: {
        type: 'boolean',
        description: 'Treat query as literal string, not regex (default: false)',
      },
      mode: {
        type: 'string',
        enum: ['content', 'files', 'count'],
        description: 'Output mode (default: content)',
      },
    },
    required: ['query'],
  },
};

const TOOL_WRITE_PLAN = {
  name: 'write_plan',
  description:
    "Persist a plan artifact to the project's plans ConfigMap. " +
    'Planner agents call this after creating their plan markdown file, ' +
    'so the plan is queryable via read_plan even after worktrees are cleaned up.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project name' },
      task: { type: 'string', description: 'Plan task ID' },
      content: { type: 'string', description: 'Full markdown content of the plan' },
    },
    required: ['project', 'task', 'content'],
  },
};

const TOOL_READ_PLAN = {
  name: 'read_plan',
  description:
    "Read a plan artifact from the project's plans ConfigMap. " +
    'Returns plan content if it exists, or null if no plan has been written yet.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project name' },
      task: { type: 'string', description: 'Plan task ID' },
    },
    required: ['project', 'task'],
  },
};

const TOOL_READ_SESSION = {
  name: 'read_session',
  description:
    "Read session messages from a completed run's ConfigMap snapshot. " +
    'Returns all session messages for the given run. Does not require a session ID.',
  inputSchema: {
    type: 'object',
    properties: {
      runName: { type: 'string', description: 'Name of the completed run' },
    },
    required: ['runName'],
  },
};

const TOOL_REPORT_FINDING = {
  name: 'report_finding',
  description:
    'Report an off-task issue you noticed while working — a bug, security problem, ' +
    'performance issue, or tech debt that is OUTSIDE your assigned task. The manager ' +
    'triages it, de-duplicates against existing findings, and may file a task. ' +
    'Do NOT use this for your own task; finish that and report only incidental discoveries. ' +
    'Returns { id, status: "accepted" }. Deduplication happens asynchronously.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'One-line summary (≤256 chars)' },
      description: { type: 'string', description: 'What is wrong, why it matters, suggested fix' },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      category: {
        type: 'string',
        enum: ['bug', 'security', 'performance', 'debt', 'docs', 'other'],
      },
      filePath: { type: 'string', description: 'Repo-relative path of the issue (optional)' },
      snippet: { type: 'string', description: 'Short code excerpt, ≤2048 chars (optional)' },
    },
    required: ['title', 'description', 'severity', 'category'],
  },
};

// ---------------------------------------------------------------------------
// search_code handler

interface SearchMatch {
  file: string;
  line: number;
  column: number;
  match: string;
  contextBefore: string[];
  contextAfter: string[];
}

function execCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        maxBuffer: 5 * 1024 * 1024,
        timeout: timeoutMs,
        cwd: '/workspace',
      },
      (err, stdout, stderr) => {
        const exitCode = (err as { code?: unknown } | null)?.code;
        // rg and grep exit 1 when no matches found — not an error.
        if (exitCode === 1) {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

async function handleSearchCode(
  id: JsonRpcRequest['id'],
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const query = String(args.query ?? '');
  if (!query) {
    return ok(id, {
      content: [{ type: 'text', text: JSON.stringify({ error: 'query is required' }) }],
    });
  }

  const searchPath = String(args.path ?? '/workspace');
  const filePattern = args.filePattern ? String(args.filePattern) : undefined;
  const contextLines = Math.min(Math.max(Number(args.contextLines) || 2, 0), 10);
  const maxResults = Math.min(Math.max(Number(args.maxResults) || 50, 1), 200);
  const fixedStrings = args.fixedStrings === true;
  const mode = String(args.mode ?? 'content') as 'content' | 'files' | 'count';

  const timeoutMs = 30_000;

  // Check if rg (ripgrep) is available.
  const useRg = await hasRipgrep();
  const isContextMode = mode === 'content';

  let stdout: string;
  if (useRg) {
    const rgArgs: string[] = ['--json', '-i', '--no-heading'];
    if (isContextMode) rgArgs.push('-C', String(contextLines));
    if (filePattern) rgArgs.push('-g', filePattern);
    if (fixedStrings) rgArgs.push('-F');
    rgArgs.push(query, searchPath);
    const result = await execCommand('rg', rgArgs, timeoutMs);
    stdout = result.stdout;
  } else {
    // Fallback to grep -rn
    const grepArgs: string[] = ['-rn', '-i'];
    if (fixedStrings) grepArgs.push('-F');
    if (filePattern) grepArgs.push('--include', filePattern);
    if (isContextMode && contextLines > 0) grepArgs.push('-C', String(contextLines));
    grepArgs.push(query, searchPath);
    const result = await execCommand('grep', grepArgs, timeoutMs);
    stdout = result.stdout;
  }

  // Parse output
  let matches: SearchMatch[];
  let totalMatches: number;

  if (useRg) {
    const parsed = parseRgJson(stdout, searchPath, isContextMode, contextLines);
    matches = parsed.matches;
    totalMatches = parsed.total;
  } else {
    const parsed = parseGrepOutput(stdout, searchPath, isContextMode, contextLines);
    matches = parsed.matches;
    totalMatches = parsed.total;
  }

  if (mode === 'count') {
    return ok(id, {
      content: [{ type: 'text', text: JSON.stringify({ totalMatches, searchPath, query }) }],
    });
  }

  if (mode === 'files') {
    const files = [...new Set(matches.map((m) => m.file))];
    return ok(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ files, totalFiles: files.length, searchPath, query }),
        },
      ],
    });
  }

  const truncated = matches.length > maxResults;
  const returned = matches.slice(0, maxResults);

  return ok(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          matches: returned,
          totalMatches,
          returnedMatches: returned.length,
          truncated,
          engine: useRg ? 'ripgrep' : 'grep',
        }),
      },
    ],
  });
}

let _hasRg: boolean | undefined;

async function hasRipgrep(): Promise<boolean> {
  if (_hasRg !== undefined) return _hasRg;
  try {
    await execCommand('rg', ['--version'], 5000);
    _hasRg = true;
  } catch {
    _hasRg = false;
  }
  return _hasRg;
}

// ---------------------------------------------------------------------------
// rg JSON output parser

interface RgMatch {
  type: string;
  data: {
    path?: { text: string };
    lines?: { text: string };
    line_number?: number;
    absolute_offset?: number;
    submatches?: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

function parseRgJson(
  stdout: string,
  _searchPath: string,
  _isContextMode: boolean,
  _contextLines: number,
): { matches: SearchMatch[]; total: number } {
  const matches: SearchMatch[] = [];
  const contextBuffer = new Map<string, string[]>();

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let parsed: RgMatch;
    try {
      parsed = JSON.parse(line) as RgMatch;
    } catch {
      continue;
    }

    if (parsed.type === 'match') {
      const file = parsed.data.path?.text ?? '';
      const lineNum = parsed.data.line_number ?? 0;
      const matchText = parsed.data.lines?.text?.trimEnd() ?? '';
      const column = parsed.data.submatches?.[0]?.start ?? 0;

      // Collect context lines around this match from surrounding context events.
      const before = (contextBuffer.get(`${file}:${lineNum - 1}`) ?? []).slice(-_contextLines);
      const after = (contextBuffer.get(`${file}:${lineNum + 1}`) ?? []).slice(0, _contextLines);

      matches.push({
        file,
        line: lineNum,
        column: column + 1,
        match: matchText,
        contextBefore: before,
        contextAfter: after,
      });
    } else if (parsed.type === 'context') {
      const file = parsed.data.path?.text ?? '';
      const lineNum = parsed.data.line_number ?? 0;
      const text = parsed.data.lines?.text?.trimEnd() ?? '';
      contextBuffer.set(`${file}:${lineNum}`, [
        ...(contextBuffer.get(`${file}:${lineNum - 1}`) ?? []),
        `${lineNum}: ${text}`,
      ]);
    }
  }

  return { matches, total: matches.length };
}

// ---------------------------------------------------------------------------
// grep -rn output parser

function parseGrepOutput(
  stdout: string,
  _searchPath: string,
  _isContextMode: boolean,
  _contextLines: number,
): { matches: SearchMatch[]; total: number } {
  const matches: SearchMatch[] = [];
  // Context lines from grep -C output are separated by --
  const blocks = stdout.split('\n--\n');

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const matchLines: string[] = [];
    const contextBefore: string[] = [];
    const contextAfter: string[] = [];
    let inContextAfter = false;

    for (const line of lines) {
      // Grep match format: file:line:content
      const match = line.match(/^([^:]+):(\d+):(.+)$/);
      if (match) {
        matchLines.push(line);
        inContextAfter = false;
      } else if (line.startsWith('-')) {
        inContextAfter = true;
      } else if (inContextAfter) {
        contextAfter.push(line);
      } else {
        contextBefore.push(line);
      }
    }

    for (const ml of matchLines) {
      const m = ml.match(/^([^:]+):(\d+):(.+)$/);
      if (!m) continue;
      const file = m[1] ?? '';
      const lineNum = parseInt(m[2] ?? '0', 10);
      const matchText = m[3] ?? '';

      matches.push({
        file,
        line: lineNum,
        column: 1,
        match: matchText,
        contextBefore: contextBefore.slice(-_contextLines),
        contextAfter: contextAfter.slice(0, _contextLines),
      });
    }
  }

  return { matches, total: matches.length };
}

// ---------------------------------------------------------------------------
// write_plan / read_plan handlers

async function handleWritePlan(
  id: JsonRpcRequest['id'],
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const project = String(args.project ?? '');
  const task = String(args.task ?? '');
  const content = String(args.content ?? '');
  if (!project || !task || !content) {
    return rpcError(id, -32602, 'project, task, and content are required');
  }
  try {
    const result = await writePlanToConfigMap(project, task, content);
    return ok(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    });
  } catch (e) {
    return rpcError(id, -32603, `failed to write plan: ${(e as Error).message}`);
  }
}

async function handleReadPlan(
  id: JsonRpcRequest['id'],
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const project = String(args.project ?? '');
  const task = String(args.task ?? '');
  if (!project || !task) {
    return rpcError(id, -32602, 'project and task are required');
  }
  try {
    const content = await readPlanFromConfigMap(project, task);
    return ok(id, {
      content: [{ type: 'text', text: JSON.stringify({ exists: content !== null, content }) }],
    });
  } catch (e) {
    return rpcError(id, -32603, `failed to read plan: ${(e as Error).message}`);
  }
}

async function handleReadSession(
  id: JsonRpcRequest['id'],
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const runName = String(args.runName ?? '');
  const ns = process.env.RUN_NAMESPACE ?? 'percussionist';
  if (!runName) {
    return rpcError(id, -32602, 'runName is required');
  }
  try {
    const data = await readAllSessionsFromConfigMap(runName, ns);
    if (!data) {
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify({ exists: false, messages: [] }, null, 2) }],
      });
    }
    return ok(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { exists: true, sessions: data.sessions.length, messages: data.allMessages },
            null,
            2,
          ),
        },
      ],
    });
  } catch (e) {
    return rpcError(id, -32603, `failed to read session: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Request body reader

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// MCP handler

type RunStatus = {
  phase: string;
  session?: string;
  tokensIn?: number;
  tokensOut?: number;
};
type CompletionToolName = 'complete_run' | 'complete_plan' | 'complete_review' | 'complete_merge';

type RunCompletionContext = 'plan-worker' | 'build-worker' | 'review-facilitator' | 'merge-worker';

type CompletionAuthorization = {
  context: RunCompletionContext;
  allowedTool: CompletionToolName;
  requiredCapability: AgentCapability;
  allowed: boolean;
  denialReason?: string;
};

const COMPLETION_TOOL_NAMES = new Set<CompletionToolName>([
  'complete_run',
  'complete_plan',
  'complete_review',
  'complete_merge',
]);

function completionPolicyForContext(context: RunCompletionContext): {
  allowedTool: CompletionToolName;
  requiredCapability: AgentCapability;
} {
  if (context === 'plan-worker') {
    return { allowedTool: 'complete_plan', requiredCapability: 'run.complete.plan' };
  }
  if (context === 'review-facilitator') {
    return { allowedTool: 'complete_review', requiredCapability: 'run.complete.review' };
  }
  if (context === 'merge-worker') {
    return { allowedTool: 'complete_merge', requiredCapability: 'task.merge.execute' };
  }
  return { allowedTool: 'complete_run', requiredCapability: 'run.complete.build' };
}

function parseContextHint(value: string | undefined): RunCompletionContext | undefined {
  switch (value) {
    case 'plan-worker':
    case 'build-worker':
    case 'review-facilitator':
    case 'merge-worker':
      return value;
    // Operator hint for non-review facilitation runs (failure/buildgen).
    case 'facilitator':
      return 'build-worker';
    default:
      return undefined;
  }
}

async function inferRunCompletionContext(): Promise<RunCompletionContext> {
  const explicit = parseContextHint(process.env.RUN_CONTEXT);
  if (explicit) return explicit;

  const runName = process.env.RUN_NAME ?? '';
  const boardTaskName = process.env.RUN_BOARD_TASK ?? '';
  const namespace = process.env.RUN_NAMESPACE ?? 'percussionist';

  try {
    if (runName) {
      const run = await getRun(runName, namespace);
      const facilitation = run.spec?.facilitation;
      if (facilitation) {
        return facilitation.successReview === true ? 'review-facilitator' : 'build-worker';
      }
    }
  } catch {
    // Fallback to task-type inference.
  }

  if (boardTaskName) {
    try {
      const task = await getTask(boardTaskName, namespace);
      if (task.spec.type === 'PLAN') {
        return 'plan-worker';
      }
    } catch {
      // Fall through to build-worker default.
    }
  }

  return 'build-worker';
}

async function resolveCompletionAuthorization(): Promise<CompletionAuthorization> {
  const context = await inferRunCompletionContext();
  const { allowedTool, requiredCapability } = completionPolicyForContext(context);

  const agentName = process.env.RUN_AGENT ?? '';
  if (!agentName) {
    return {
      context,
      allowedTool,
      requiredCapability,
      allowed: false,
      denialReason: `RUN_AGENT not set (requires capability "${requiredCapability}")`,
    };
  }

  try {
    const clusterAgent = await getClusterAgent(agentName);
    const capabilities = clusterAgent.spec.capabilities ?? [];
    if (!capabilities.includes(requiredCapability)) {
      return {
        context,
        allowedTool,
        requiredCapability,
        allowed: false,
        denialReason: `agent "${agentName}" missing required capability "${requiredCapability}" for context "${context}"`,
      };
    }
    return { context, allowedTool, requiredCapability, allowed: true };
  } catch (e) {
    return {
      context,
      allowedTool,
      requiredCapability,
      allowed: false,
      denialReason: `failed to resolve cluster agent "${agentName}": ${(e as Error).message}`,
    };
  }
}

async function handleCreateTask(
  id: JsonRpcRequest['id'],
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const projectName = process.env.RUN_PROJECT ?? '';
  const boardTask = process.env.RUN_BOARD_TASK ?? '';
  const ns = process.env.RUN_NAMESPACE ?? 'percussionist';

  if (!projectName) {
    return rpcError(id, -32602, 'RUN_PROJECT not set');
  }

  const title = String(args.title ?? '');
  const agent = String(args.agent ?? '');
  if (!title || !agent) {
    return rpcError(id, -32602, 'title and agent are required');
  }
  const description = args.description ? String(args.description) : undefined;
  const priority = String(args.priority ?? 'medium');
  const predecessorRef = args.predecessorRef ? String(args.predecessorRef) : undefined;

  try {
    const project = await getProject(projectName, ns);
    const validation = await validateAgentTaskCapability(project, 'BUILD', agent);
    if (!validation.ok) {
      return rpcError(id, -32602, validation.error);
    }

    const suffix = randomBytes(3).toString('hex');
    const taskName = `${projectName}-build-${suffix}`;

    const task = buildTask({
      name: taskName,
      projectName,
      projectUid: project.metadata.uid ?? '',
      ns,
      spec: {
        projectRef: projectName,
        type: 'BUILD',
        title,
        description,
        agent,
        priority: priority as 'high' | 'medium' | 'low',
        parentTaskRef: boardTask || undefined,
        predecessorRef,
      },
    });

    await createTask(task, ns);

    // Ensure status.phase is persisted (defense-in-depth; buildTask sets it
    // but K8s may strip initial status on some CRD setups).
    await patchTaskStatus(taskName, { phase: 'pending' }, ns).catch(() => {
      /* best effort */
    });

    return ok(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ taskName, project: projectName, type: 'BUILD', phase: 'pending' }),
        },
      ],
    });
  } catch (e) {
    return rpcError(id, -32603, `failed to create task: ${(e as Error).message}`);
  }
}

function normalizeFindingText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function computeDedupKey(category: string, filePath: string | undefined, title: string): string {
  const parts = [
    category,
    filePath ? normalizeFindingText(filePath) : '',
    normalizeFindingText(title),
  ];
  return createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 16);
}

async function handleReportFinding(
  id: JsonRpcRequest['id'],
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const project = process.env.RUN_PROJECT ?? '';
  const task = process.env.RUN_BOARD_TASK ?? '';
  const run = process.env.RUN_NAME ?? '';
  const agent = process.env.RUN_AGENT ?? '';
  const ns = process.env.RUN_NAMESPACE ?? 'percussionist';

  if (!project) {
    return rpcError(id, -32602, 'RUN_PROJECT not set — cannot report finding outside a run pod');
  }

  const title = String(args.title ?? '').trim();
  const description = String(args.description ?? '').trim();
  const severity = String(args.severity ?? '');
  const category = String(args.category ?? '');
  const filePath = args.filePath ? String(args.filePath).trim() : undefined;
  const snippet = args.snippet ? String(args.snippet).trim() : undefined;

  if (!title) return rpcError(id, -32602, 'title is required');
  if (!description) return rpcError(id, -32602, 'description is required');
  if (!severity) return rpcError(id, -32602, 'severity is required');
  if (!category) return rpcError(id, -32602, 'category is required');

  const parsed = FindingSchema.safeParse({
    id: 'pending',
    title: title.slice(0, 256),
    description: description.slice(0, 8192),
    severity,
    category,
    source: { project, task: task || undefined, run: run || undefined, agent: agent || undefined },
    filePath: filePath?.slice(0, 1024),
    snippet: snippet?.slice(0, 2048),
    status: 'new',
    dedupKey: 'pending',
    occurrences: 1,
    createdAt: new Date().toISOString(),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return rpcError(id, -32602, `invalid finding: ${issues}`);
  }

  const findingId = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const dedupKey = computeDedupKey(category, filePath, title);

  const finding: Finding = {
    ...parsed.data,
    id: findingId,
    dedupKey,
  };

  try {
    await appendFindingToConfigMap(project, finding, ns);
    return ok(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ id: findingId, status: 'accepted' }),
        },
      ],
    });
  } catch (e) {
    return rpcError(id, -32603, `failed to report finding: ${(e as Error).message}`);
  }
}

async function handleMcp(
  req: JsonRpcRequest,
  onFailRun: (reason: string) => void,
  onCompleteRun: (summary: string) => void,
  onCompletePlan: (summary: string) => void,
  getStatus: () => RunStatus | null,
  getCompletionAuth: () => Promise<CompletionAuthorization>,
): Promise<JsonRpcResponse> {
  switch (req.method) {
    case 'initialize':
      return ok(req.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'notifications/initialized':
      // Fire-and-forget notification — no response needed, but respond anyway
      // with a no-op to keep some clients happy.
      return ok(req.id, {});

    case 'tools/list': {
      const completionAuth = await getCompletionAuth();
      const completionTools = completionAuth.allowed
        ? [
            completionAuth.allowedTool === 'complete_run'
              ? TOOL_COMPLETE_RUN
              : completionAuth.allowedTool === 'complete_plan'
                ? TOOL_COMPLETE_PLAN
                : completionAuth.allowedTool === 'complete_merge'
                  ? TOOL_COMPLETE_MERGE
                  : TOOL_COMPLETE_REVIEW,
          ]
        : [];
      return ok(req.id, {
        tools: [
          TOOL_FAIL_RUN,
          ...completionTools,
          TOOL_GET_STATUS,
          TOOL_CREATE_TASK,
          TOOL_SEARCH_CODE,
          TOOL_WRITE_PLAN,
          TOOL_READ_PLAN,
          TOOL_READ_SESSION,
          TOOL_REPORT_FINDING,
        ],
      });
    }

    case 'tools/call': {
      const toolName = (req.params?.name as string | undefined) ?? '';
      if (COMPLETION_TOOL_NAMES.has(toolName as CompletionToolName)) {
        const completionAuth = await getCompletionAuth();
        if (!completionAuth.allowed) {
          return rpcError(
            req.id,
            -32602,
            `completion tool "${toolName}" is not allowed: ${completionAuth.denialReason ?? 'missing capability'}`,
          );
        }
        if (toolName !== completionAuth.allowedTool) {
          return rpcError(
            req.id,
            -32602,
            `completion tool "${toolName}" is not allowed in context "${completionAuth.context}"; allowed tool is "${completionAuth.allowedTool}"`,
          );
        }
      }

      if (toolName === 'fail_run') {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const reason =
          typeof args.reason === 'string' ? args.reason : 'agent called fail_run without a reason';
        onFailRun(reason);
        return ok(req.id, {
          content: [
            { type: 'text', text: 'Run marked as failed. The orchestrator will investigate.' },
          ],
        });
      }

      if (toolName === 'complete_run') {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const summary =
          typeof args.summary === 'string'
            ? args.summary
            : 'agent called complete_run without a summary';
        onCompleteRun(summary);
        return ok(req.id, {
          content: [
            {
              type: 'text',
              text: 'Run marked as complete. The orchestrator will review the result.',
            },
          ],
        });
      }

      if (toolName === 'complete_plan') {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const summary =
          typeof args.summary === 'string'
            ? args.summary
            : 'agent called complete_plan without a summary';
        onCompletePlan(summary);
        return ok(req.id, {
          content: [
            {
              type: 'text',
              text: 'Plan marked as complete. The orchestrator will review the plan artifact.',
            },
          ],
        });
      }

      if (toolName === 'complete_merge') {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const diagnosis = typeof args.diagnosis === 'string' ? args.diagnosis : '';
        if (!diagnosis) {
          return rpcError(req.id, -32602, 'diagnosis is required');
        }

        const rawVerdict = {
          outcome: args.outcome,
          diagnosis,
          details: typeof args.details === 'string' ? args.details : undefined,
          sourceBranch: typeof args.sourceBranch === 'string' ? args.sourceBranch : undefined,
          targetBranch: typeof args.targetBranch === 'string' ? args.targetBranch : undefined,
          mergeCommitSha: typeof args.mergeCommitSha === 'string' ? args.mergeCommitSha : undefined,
          requiresHuman: typeof args.requiresHuman === 'boolean' ? args.requiresHuman : undefined,
        };

        const verdict = normalizeMergeVerdict(rawVerdict);
        if (!verdict) {
          return rpcError(
            req.id,
            -32602,
            'outcome must be one of merged, already-merged, conflict, push-failed, transient-failure',
          );
        }

        const runName = process.env.RUN_NAME ?? '';
        const namespace = process.env.RUN_NAMESPACE ?? 'percussionist';

        // Best-effort annotation write — never block completion
        try {
          await patchRunAnnotations(
            runName,
            {
              [MERGE_VERDICT_ANNOTATION]: JSON.stringify(verdict),
            },
            namespace,
          );
        } catch (e) {
          console.error(
            '[mcp-server] complete_merge: failed to patch annotations:',
            (e as Error).message,
          );
        }

        const summary = `merge ${verdict.outcome}: ${diagnosis}`;
        onCompleteRun(summary);
        return ok(req.id, {
          content: [
            {
              type: 'text',
              text: `Merge verdict submitted: ${verdict.outcome}. The orchestrator will process the verdict.`,
            },
          ],
        });
      }

      if (toolName === 'complete_review') {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const approved = args.approved === true;
        const diagnosis = typeof args.diagnosis === 'string' ? args.diagnosis : '';
        if (!diagnosis) {
          return rpcError(req.id, -32602, 'diagnosis is required');
        }
        const feedback = typeof args.feedback === 'string' ? args.feedback : undefined;
        const suggestion = typeof args.suggestion === 'string' ? args.suggestion : undefined;
        const findings = Array.isArray(args.findings) ? args.findings : undefined;

        const runName = process.env.RUN_NAME ?? '';
        const namespace = process.env.RUN_NAMESPACE ?? 'percussionist';
        const updatedAt = new Date().toISOString();

        const rawVerdict = {
          action: approved ? 'approve' : 'request_changes',
          diagnosis,
          feedback,
          suggestion,
          ...(findings ? { findings } : {}),
        };

        const verdict = normalizeReviewVerdict(rawVerdict, {
          sourceRunName: runName,
          updatedAt,
        });

        if (!verdict) {
          return rpcError(req.id, -32602, 'invalid verdict payload');
        }

        // Best-effort annotation write — never block completion
        try {
          await patchRunAnnotations(
            runName,
            {
              'percussionist.dev/review-verdict': JSON.stringify(verdict),
            },
            namespace,
          );
        } catch (e) {
          console.error(
            '[mcp-server] complete_review: failed to patch annotations:',
            (e as Error).message,
          );
        }

        const actionLabel = approved ? 'approved' : 'requested changes on';
        onCompleteRun(
          `reviewer ${actionLabel} ${process.env.RUN_BOARD_TASK ?? 'task'} — ${diagnosis}`,
        );
        return ok(req.id, {
          content: [
            {
              type: 'text',
              text: `Review submitted: ${actionLabel}. The orchestrator will process the verdict.`,
            },
          ],
        });
      }

      if (toolName === 'get_status') {
        const status = getStatus();
        if (!status) {
          return ok(req.id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ phase: 'unknown', error: 'status not yet available' }),
              },
            ],
          });
        }
        return ok(req.id, {
          content: [{ type: 'text', text: JSON.stringify(status) }],
        });
      }

      if (toolName === 'create_task') {
        return handleCreateTask(req.id, (req.params?.arguments ?? {}) as Record<string, unknown>);
      }

      if (toolName === 'search_code') {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        return handleSearchCode(req.id, args);
      }

      if (toolName === 'write_plan') {
        return handleWritePlan(req.id, (req.params?.arguments ?? {}) as Record<string, unknown>);
      }

      if (toolName === 'read_plan') {
        return handleReadPlan(req.id, (req.params?.arguments ?? {}) as Record<string, unknown>);
      }

      if (toolName === 'read_session') {
        return handleReadSession(req.id, (req.params?.arguments ?? {}) as Record<string, unknown>);
      }

      if (toolName === 'report_finding') {
        return handleReportFinding(
          req.id,
          (req.params?.arguments ?? {}) as Record<string, unknown>,
        );
      }

      return rpcError(req.id, -32602, `unknown tool: ${toolName}`);
    }

    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

export const __test = {
  handleMcp,
  completionPolicyForContext,
  parseContextHint,
  computeDedupKey,
  normalizeFindingText,
};

// ---------------------------------------------------------------------------
// Server lifecycle

export interface McpServer {
  close(): void;
  port: number;
}

export function startMcpServer(
  onFailRun: (reason: string) => void,
  onCompleteRun: (summary: string) => void,
  onCompletePlan: (summary: string) => void,
  getStatus: () => RunStatus | null,
  port: number = DISPATCHER_MCP_PORT,
): Promise<McpServer> {
  return new Promise((resolve, reject) => {
    let completionAuthPromise: Promise<CompletionAuthorization> | undefined;
    const getCompletionAuth = (): Promise<CompletionAuthorization> => {
      completionAuthPromise ??= resolveCompletionAuthorization();
      return completionAuthPromise;
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      readBody(req)
        .then(async (body) => {
          let rpc: JsonRpcRequest;
          try {
            rpc = JSON.parse(body) as JsonRpcRequest;
          } catch {
            const errRes: JsonRpcResponse = rpcError(null, -32700, 'parse error');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errRes));
            return;
          }

          // Notifications have no id — return 202 with empty body.
          if (rpc.id === undefined || rpc.id === null) {
            handleMcp(rpc, onFailRun, onCompleteRun, onCompletePlan, getStatus, getCompletionAuth); // side-effects only (e.g. notifications/initialized)
            res.writeHead(202);
            res.end();
            return;
          }

          const response = await Promise.resolve(
            handleMcp(rpc, onFailRun, onCompleteRun, onCompletePlan, getStatus, getCompletionAuth),
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        })
        .catch((e) => {
          const errRes: JsonRpcResponse = rpcError(null, -32603, String((e as Error).message));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errRes));
        });
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const listeningPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        close() {
          server.close();
        },
        port: listeningPort,
      });
    });
  });
}

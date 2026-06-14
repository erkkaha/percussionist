// mcp-server.ts — MCP (Model Context Protocol) HTTP server for run-pod agents.
//
// Exposes tools: fail_run, complete_run, complete_plan, get_status, create_task,
//                search_code, write_plan, read_plan, read_session
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
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DISPATCHER_MCP_PORT, normalizeReviewVerdict } from '@percussionist/api';
import {
  buildTask,
  createTask,
  getProject,
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
        type: "array",
        description:
          "Optional structured diff findings (max 25). Each finding has severity, title, comment, " +
          "1-3 line anchors, and diff context. Invalid or overflowing findings are dropped; core verdict still writes.",
        maxItems: 25,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique finding ID" },
            severity: {
              type: "string",
              enum: ["critical", "high", "medium", "low", "info"],
            },
            score: { type: "number", minimum: 0, maximum: 100 },
            title: { type: "string", maxLength: 160 },
            comment: { type: "string", maxLength: 2000 },
            category: { type: "string", maxLength: 64 },
            anchors: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  side: { type: "string", enum: ["old", "new"] },
                  line: { type: "integer", minimum: 1 },
                  endLine: { type: "integer", minimum: 1 },
                  hunkHeader: { type: "string", maxLength: 256 },
                },
                required: ["path", "side", "line"],
              },
            },
            context: {
              type: "object",
              properties: {
                baseSha: { type: "string" },
                headSha: { type: "string" },
                forkSha: { type: "string" },
                diffFingerprint: { type: "string" },
              },
              required: ["baseSha", "headSha", "forkSha", "diffFingerprint"],
            },
            createdAt: { type: "string" },
            authorRunName: { type: "string" },
          },
          required: ["id", "severity", "title", "comment", "anchors", "context", "createdAt"],
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

async function handleMcp(
  req: JsonRpcRequest,
  onFailRun: (reason: string) => void,
  onCompleteRun: (summary: string) => void,
  onCompletePlan: (summary: string) => void,
  getStatus: () => RunStatus | null,
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

    case 'tools/list':
      return ok(req.id, {
        tools: [
          TOOL_FAIL_RUN,
          TOOL_COMPLETE_RUN,
          TOOL_COMPLETE_PLAN,
          TOOL_COMPLETE_REVIEW,
          TOOL_GET_STATUS,
          TOOL_CREATE_TASK,
          TOOL_SEARCH_CODE,
          TOOL_WRITE_PLAN,
          TOOL_READ_PLAN,
          TOOL_READ_SESSION,
        ],
      });

    case 'tools/call': {
      const toolName = (req.params?.name as string | undefined) ?? '';

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
          return rpcError(req.id, -32602, "invalid verdict payload");
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

      return rpcError(req.id, -32602, `unknown tool: ${toolName}`);
    }

    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle

export interface McpServer {
  close(): void;
}

export function startMcpServer(
  onFailRun: (reason: string) => void,
  onCompleteRun: (summary: string) => void,
  onCompletePlan: (summary: string) => void,
  getStatus: () => RunStatus | null,
): Promise<McpServer> {
  return new Promise((resolve, reject) => {
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
            handleMcp(rpc, onFailRun, onCompleteRun, onCompletePlan, getStatus); // side-effects only (e.g. notifications/initialized)
            res.writeHead(202);
            res.end();
            return;
          }

          const response = await Promise.resolve(
            handleMcp(rpc, onFailRun, onCompleteRun, onCompletePlan, getStatus),
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
    server.listen(DISPATCHER_MCP_PORT, '127.0.0.1', () => {
      resolve({
        close() {
          server.close();
        },
      });
    });
  });
}

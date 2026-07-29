// tool-names.ts — normalise Claude Code tool names to the lowercase form the
// web dashboard expects.
//
// This exists because of one load-bearing comparison: SessionView.tsx filters
// `p.tool !== 'todowrite'` to route todo updates into the checklist widget
// instead of a generic tool row.  OpenCode emits lowercase tool names; the
// Agent SDK emits PascalCase (`TodoWrite`, `Read`, `Bash`).  Without this the
// dashboard silently degrades — every todo update renders as an opaque tool
// call, with no error to point at the cause.

/**
 * Names whose lowercase form is not simply `name.toLowerCase()`, or which we
 * want to pin explicitly so a future SDK rename surfaces here rather than in
 * the UI.  Anything absent falls through to `toLowerCase()`.
 */
const EXPLICIT: Record<string, string> = {
  TodoWrite: 'todowrite',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  NotebookEdit: 'notebookedit',
  MultiEdit: 'multiedit',
  BashOutput: 'bashoutput',
  KillShell: 'killshell',
  Task: 'task',
};

/**
 * MCP tools arrive as `mcp__<server>__<tool>` — already lowercase by
 * convention and meaningful as a whole, so they pass through untouched.  This
 * is how the dispatcher's own `fail_run` / `get_status` reach the transcript.
 */
export function normalizeToolName(name: string): string {
  if (name.startsWith('mcp__')) return name;
  return EXPLICIT[name] ?? name.toLowerCase();
}

/**
 * Tools whose input names a file we should surface as a distinct `file` part.
 * SessionTimeline.tsx renders these as file-change rows; the SDK has no
 * equivalent event, so we synthesise them from the tool call's input.
 */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function isFileTool(name: string): boolean {
  return FILE_TOOLS.has(name);
}

/** The Agent/Task tool spawns a subagent, which the timeline shows as a subtask. */
export function isSubagentTool(name: string): boolean {
  return name === 'Task' || name === 'Agent';
}

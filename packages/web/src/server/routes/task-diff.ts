import { Hono } from "hono";
import { NAMESPACE, getProject, getTask, getRun } from "../kube.js";

type DiffFile = {
  path: string;
  diff: string;
};

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function gitUrlHash(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function splitDiffByFile(diffText: string): DiffFile[] {
  const lines = diffText.split("\n");
  const files: DiffFile[] = [];
  let current: string[] = [];
  let currentPath = "";

  const pushCurrent = () => {
    if (current.length === 0) return;
    files.push({ path: currentPath || "(unknown)", diff: current.join("\n") });
    current = [];
    currentPath = "";
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushCurrent();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      currentPath = m?.[2] ?? m?.[1] ?? "(unknown)";
      current.push(line);
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  pushCurrent();
  return files;
}

function firstOutputLine(output: string): string | undefined {
  return output.split("\n").map((line) => line.trim()).find(Boolean);
}

const router = new Hono();
const MANAGER_SERVICE = `http://percussionist-manager.${NAMESPACE}.svc.cluster.local`;
const MCP_URL = `${MANAGER_SERVICE}:4097/mcp`;

async function execInWorkspaceViaManager(
  project: string,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number | null }> {
  const mcpRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "exec_in_workspace",
      arguments: {
        project,
        command,
        mountPath: "/data",
        timeoutSeconds: Math.ceil(timeoutMs / 1000),
        namespace: NAMESPACE,
      },
    },
  };

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mcpRequest),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  });

  if (!res.ok) {
    throw new Error(`Manager MCP service returned ${res.status}`);
  }

  const mcpResponse = (await res.json()) as {
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { message?: string };
  };

  if (mcpResponse.error) {
    throw new Error(mcpResponse.error.message ?? "Manager MCP error");
  }

  const rawText = mcpResponse.result?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(rawText) as {
    stdout?: string;
    exitCode?: number | null;
  };

  return {
    stdout: parsed.stdout ?? "",
    exitCode: parsed.exitCode ?? null,
  };
}

router.get("/:project/tasks/:taskName/diff", async (c) => {
  const projectName = c.req.param("project");
  const taskName = c.req.param("taskName");

  if (!projectName || !taskName) {
    return c.json({ error: "Missing required parameters: project, taskName" }, 400);
  }

  try {
    const [project, task] = await Promise.all([
      getProject(projectName, NAMESPACE),
      getTask(taskName, NAMESPACE),
    ]);

    const worker = task.status?.worker;
    const defaultRef = project.spec.source?.git?.ref ?? "main";

    let baseRef = worker?.mergeIntoBranch ?? worker?.parentBranch;
    let headRef = worker?.gitBranch;

    // Fallback for clusters where branch metadata is not patched to Task.status.worker.
    // The run spec still contains the concrete git refs that were checked out.
    if ((!baseRef || !headRef) && worker?.runName) {
      try {
        const run = await getRun(worker.runName, NAMESPACE);
        baseRef = baseRef ?? run.spec.source?.git?.parentRef;
        headRef = headRef ?? run.spec.source?.git?.ref;
      } catch {
        // Best-effort fallback; continue with project defaults.
      }
    }

    baseRef = baseRef ?? defaultRef;
    headRef = headRef ?? defaultRef;

    if (baseRef === headRef) {
      return c.json({
        project: projectName,
        task: taskName,
        defaultRef,
        baseRef,
        headRef,
        files: [],
        empty: true,
        reason: "No changes: base and head refs are identical",
      });
    }

    const source = project.spec.source;
    let repoPath: string;
    let worktreePath: string | null = null;

    if (source?.local) {
      repoPath = "/data/workspace";
    } else if (source?.git?.url) {
      const urlHash = gitUrlHash(source.git.url);
      repoPath = `/data/git-mirrors/${urlHash}`;
      // Use the worktree HEAD for accurate diffs — the agent may have committed
      // locally without pushing, and mirror refs can be stale for active worktrees.
      if (worker?.runName) {
        worktreePath = `/data/worktrees/${worker.runName}`;
      }
    } else {
      return c.json(
        {
          project: projectName,
          task: taskName,
          defaultRef,
          baseRef,
          headRef,
          files: [],
          empty: true,
          reason: "Project has no git source configured",
        },
        400,
      );
    }

    const resolveRefScript = [
      'resolve_ref() { _repo="$1"; _ref="$2"; for _try in "$_ref" "refs/heads/$_ref" "refs/remotes/origin/$_ref" "origin/$_ref"; do if git -C "$_repo" rev-parse --verify "$_try^{commit}" >/dev/null 2>&1; then git -C "$_repo" rev-parse --verify "$_try^{commit}"; return 0; fi; done; return 1; }',
    ];

    const cmd = [
      "apk add --no-cache git >/dev/null 2>&1",
      ...resolveRefScript,
      `REPO=${quoteSh(repoPath)}`,
      `BASE=${quoteSh(baseRef)}`,
      `HEAD=${quoteSh(headRef)}`,
      ...(worktreePath ? [`WORKTREE=${quoteSh(worktreePath)}`] : []),
      ...(worktreePath
        ? [
          'if [ -d "$WORKTREE" ] && git -C "$WORKTREE" rev-parse --verify HEAD >/dev/null 2>&1; then',
          '  BASE_COMMIT=$(resolve_ref "$WORKTREE" "$BASE")',
          '  if [ -z "$BASE_COMMIT" ]; then',
          '    printf "__PERCUSSIONIST_ERROR__ base_missing %s\\n" "$BASE"',
          '    exit 0',
          '  fi',
          '  HEAD_COMMIT=$(git -C "$WORKTREE" rev-parse --verify HEAD)',
          '  git -C "$WORKTREE" diff --no-color --find-renames --binary "$BASE_COMMIT...$HEAD_COMMIT" -- || git -C "$WORKTREE" diff --no-color --find-renames --binary "$BASE_COMMIT..$HEAD_COMMIT" --',
          '  UNCOMMITTED=$(git -C "$WORKTREE" diff --no-color --find-renames --binary HEAD -- 2>/dev/null)',
          '  if [ -n "$UNCOMMITTED" ]; then',
          '    printf "\\n%s\\n" "$UNCOMMITTED"',
          '  fi',
          '  exit 0',
          'fi',
        ]
        : []),
      "if [ ! -d \"$REPO\" ]; then",
      "  printf '__PERCUSSIONIST_ERROR__ repo_not_found %s\\n' \"$REPO\"",
      "  exit 0",
      "fi",
      "BASE_COMMIT=$(resolve_ref \"$REPO\" \"$BASE\")",
      "if [ -z \"$BASE_COMMIT\" ]; then",
      "  printf '__PERCUSSIONIST_ERROR__ base_missing %s\\n' \"$BASE\"",
      "  exit 0",
      "fi",
      "HEAD_COMMIT=$(resolve_ref \"$REPO\" \"$HEAD\")",
      "if [ -z \"$HEAD_COMMIT\" ]; then",
      "  printf '__PERCUSSIONIST_ERROR__ head_missing %s\\n' \"$HEAD\"",
      "  exit 0",
      "fi",
      "git -C \"$REPO\" diff --no-color --find-renames --binary \"$BASE_COMMIT...$HEAD_COMMIT\" -- || git -C \"$REPO\" diff --no-color --find-renames --binary \"$BASE_COMMIT..$HEAD_COMMIT\" --",
    ].join("; ");

    const result = await execInWorkspaceViaManager(projectName, cmd, 120_000);
    const output = result.stdout.trim();

    if (output.startsWith("__PERCUSSIONIST_ERROR__")) {
      const reason = output.replace("__PERCUSSIONIST_ERROR__", "").trim();
      return c.json(
        {
          project: projectName,
          task: taskName,
          defaultRef,
          baseRef,
          headRef,
          files: [],
          empty: true,
          reason,
        },
        404,
      );
    }

    if (result.exitCode !== null && result.exitCode !== 0) {
      return c.json(
        {
          project: projectName,
          task: taskName,
          defaultRef,
          baseRef,
          headRef,
          files: [],
          empty: true,
          reason: firstOutputLine(output) ?? `git diff exited with code ${result.exitCode}`,
        },
        500,
      );
    }

    if (!output) {
      return c.json({
        project: projectName,
        task: taskName,
        defaultRef,
        baseRef,
        headRef,
        files: [],
        empty: true,
        reason: "No file changes between refs",
      });
    }

    const files = splitDiffByFile(output);
    if (files.length === 0) {
      return c.json({
        project: projectName,
        task: taskName,
        defaultRef,
        baseRef,
        headRef,
        files: [],
        empty: true,
        reason: firstOutputLine(output) ?? "Diff command produced no file sections",
      });
    }

    return c.json({
      project: projectName,
      task: taskName,
      defaultRef,
      baseRef,
      headRef,
      files,
      empty: files.length === 0,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

export default router;

import { Hono } from "hono";
import { NAMESPACE, getProject, getTask, getRun } from "../kube.js";
import { auth } from "../auth.js";

type DiffFile = {
  path: string;
  diff: string;
};

type DiffCommit = {
  sha: string;
  subject: string;
  body: string;
  files: DiffFile[];
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

function hexToString(hex: string): string {
  if (!hex) return "";
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return Buffer.from(bytes).toString("utf-8");
}

function parseCommitsSection(text: string): DiffCommit[] {
  const commits: DiffCommit[] = [];
  const blocks = text.split(">>>SHA=").slice(1);

  for (const block of blocks) {
    const lines = block.split("\n");
    const sha = lines[0]?.trim();
    if (!sha) continue;

    const rest = lines.slice(1).join("\n");

    const subjectMatch = rest.match(/>>>SUBJECT=([a-f0-9]*)/);
    const bodyMatch = rest.match(/>>>BODY=([a-f0-9]*)/);
    const filesMatch = rest.match(/>>>FILES\n([\s\S]*?)>>>ENDFILES/);

    const subject = subjectMatch ? hexToString(subjectMatch[1] ?? "") : "";
    const body = bodyMatch ? hexToString(bodyMatch[1] ?? "") : "";
    const filesText = filesMatch?.[1]?.trim() ?? "";
    const files = filesText ? splitDiffByFile(filesText) : [];

    commits.push({ sha, subject, body, files });
  }

  return commits;
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

router.get("/:project/tasks/:taskName/diff", auth(), async (c) => {
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

    if (source?.local) {
      repoPath = "/data/workspace";
    } else if (source?.git?.url) {
      const urlHash = gitUrlHash(source.git.url);
      repoPath = `/data/git-mirrors/${urlHash}`;
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

    const cmd = [
      "apk add --no-cache git >/dev/null 2>&1",
      `REPO=${quoteSh(repoPath)}`,
      `BASE=${quoteSh(baseRef)}`,
      `HEAD=${quoteSh(headRef)}`,
      'if [ ! -d "$REPO" ]; then printf \'__PERCUSSIONIST_ERROR__ repo_not_found %s\\n\' "$REPO"; exit 0; fi',
      'if ! git -C "$REPO" rev-parse --verify "$BASE^{commit}" >/dev/null 2>&1; then printf \'__PERCUSSIONIST_ERROR__ base_missing %s\\n\' "$BASE"; exit 0; fi',
      'if ! git -C "$REPO" rev-parse --verify "$HEAD^{commit}" >/dev/null 2>&1; then printf \'__PERCUSSIONIST_ERROR__ head_missing %s\\n\' "$HEAD"; exit 0; fi',
      'FORK=$(git -C "$REPO" merge-base "$BASE" "$HEAD" 2>/dev/null)',
      'if git -C "$REPO" merge-base --is-ancestor "$HEAD" "$BASE" 2>/dev/null; then',
      '  MERGE=$(git -C "$REPO" rev-list --merges --ancestry-path "$HEAD".."$BASE" 2>/dev/null | tail -1)',
      '  if [ -n "$MERGE" ]; then',
      '    for PARENT in $(git -C "$REPO" rev-parse "$MERGE^@" 2>/dev/null); do',
      '      if ! git -C "$REPO" merge-base --is-ancestor "$HEAD" "$PARENT" 2>/dev/null; then FORK="$PARENT"; break; fi',
      '    done',
      '  fi',
      'fi',
      'echo "___UNIFIED___"',
      'git -C "$REPO" diff --no-color --find-renames --binary "$FORK..$HEAD" -- 2>/dev/null || true',
      'echo "___COMMITS___"',
      'for SHA in $(git -C "$REPO" rev-list --no-merges "$FORK..$HEAD" 2>/dev/null | head -20); do',
      '  echo ">>>SHA=$SHA"',
      "  printf '>>>SUBJECT='",
      '  git -C "$REPO" log --format=%s -1 "$SHA" 2>/dev/null | od -A n -t x1 | tr -d " \\n"',
      "  echo ''",
      "  printf '>>>BODY='",
      '  git -C "$REPO" log --format=%b -1 "$SHA" 2>/dev/null | od -A n -t x1 | tr -d " \\n"',
      "  echo ''",
      "  echo '>>>FILES'",
      '  git -C "$REPO" diff-tree --no-color --find-renames --binary -r "$SHA" 2>/dev/null || true',
      "  echo '>>>ENDFILES'",
      'done',
    ].join("\n");

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

    let unifiedDiff = "";
    let commitsText = "";

    const unifiedMarker = "___UNIFIED___\n";
    const commitsMarker = "\n___COMMITS___\n";

    const unifiedIdx = output.indexOf(unifiedMarker);
    const commitsIdx = output.indexOf(commitsMarker);

    if (unifiedIdx !== -1) {
      const afterUnified = output.slice(unifiedIdx + unifiedMarker.length);
      if (commitsIdx !== -1) {
        unifiedDiff = afterUnified.slice(0, afterUnified.indexOf(commitsMarker));
      } else {
        unifiedDiff = afterUnified;
      }
    }

    if (commitsIdx !== -1) {
      commitsText = output.slice(commitsIdx + commitsMarker.length);
    }

    const files = unifiedDiff.trim() ? splitDiffByFile(unifiedDiff.trim()) : [];
    const commits = parseCommitsSection(commitsText);

    return c.json({
      project: projectName,
      task: taskName,
      defaultRef,
      baseRef,
      headRef,
      files,
      commits,
      empty: files.length === 0 && commits.length === 0,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

export default router;

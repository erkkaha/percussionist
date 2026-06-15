import { createHash } from 'node:crypto';
import type { DiffContext, DiffFinding } from '@percussionist/api';
import { Hono } from 'hono';
import { auth } from '../auth.js';
import { getProject, getRun, getTask, gitUrlHash, NAMESPACE } from '../kube.js';

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

function splitDiffByFile(diffText: string): DiffFile[] {
  const lines = diffText.split('\n');
  const files: DiffFile[] = [];
  let current: string[] = [];
  let currentPath = '';

  const pushCurrent = () => {
    if (current.length === 0) return;
    files.push({ path: currentPath || '(unknown)', diff: current.join('\n') });
    current = [];
    currentPath = '';
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushCurrent();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      currentPath = m?.[2] ?? m?.[1] ?? '(unknown)';
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
  if (!hex) return '';
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return Buffer.from(bytes).toString('utf-8');
}

function parseCommitsSection(text: string): DiffCommit[] {
  const commits: DiffCommit[] = [];
  const blocks = text.split('>>>SHA=').slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const sha = lines[0]?.trim();
    if (!sha) continue;

    const rest = lines.slice(1).join('\n');

    const subjectMatch = rest.match(/>>>SUBJECT=([a-f0-9]*)/);
    const bodyMatch = rest.match(/>>>BODY=([a-f0-9]*)/);
    const filesMatch = rest.match(/>>>FILES\n([\s\S]*?)>>>ENDFILES/);

    const subject = subjectMatch ? hexToString(subjectMatch[1] ?? '') : '';
    const body = bodyMatch ? hexToString(bodyMatch[1] ?? '') : '';
    const filesText = filesMatch?.[1]?.trim() ?? '';
    const files = filesText ? splitDiffByFile(filesText) : [];

    commits.push({ sha, subject, body, files });
  }

  return commits;
}

type ProjectedFinding = DiffFinding & {
  isActive: boolean;
  isStale: boolean;
};

function parseMetaSection(text: string): Partial<DiffContext> {
  const result: Partial<DiffContext> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'BASE_SHA') result.baseSha = value;
    if (key === 'HEAD_SHA') result.headSha = value;
    if (key === 'FORK_SHA') result.forkSha = value;
  }
  return result;
}

function computeDiffFingerprint(forkSha: string, headSha: string, unifiedDiff: string): string {
  const payload = `${forkSha}\n${headSha}\n${unifiedDiff.trim()}`;
  return createHash('sha256').update(payload).digest('hex');
}

const SEVERITY_RANK: Record<DiffFinding['severity'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function projectFindings(
  stored: { items: DiffFinding[] } | undefined,
  context: DiffContext,
): ProjectedFinding[] {
  const projected: ProjectedFinding[] = [];
  for (const finding of stored?.items ?? []) {
    const isActive =
      finding.context.baseSha === context.baseSha &&
      finding.context.headSha === context.headSha &&
      finding.context.forkSha === context.forkSha &&
      finding.context.diffFingerprint === context.diffFingerprint;
    projected.push({ ...finding, isActive, isStale: !isActive });
  }

  projected.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;

    const scoreA = a.score ?? 0;
    const scoreB = b.score ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;

    const anchorA = a.anchors[0];
    const anchorB = b.anchors[0];
    const pathA = anchorA?.path ?? '';
    const pathB = anchorB?.path ?? '';
    const pathCmp = pathA.localeCompare(pathB);
    if (pathCmp !== 0) return pathCmp;

    const lineA = anchorA?.line ?? 0;
    const lineB = anchorB?.line ?? 0;
    return lineA - lineB;
  });

  return projected;
}

const router = new Hono();
// The manager always runs in the operator namespace; keep the URL independent
// of the web server's PERCUSSIONIST_NAMESPACE so the diff route works when the
// web pod is deployed in a project/test namespace.
const MCP_URL = 'http://percussionist-manager.percussionist.svc.cluster.local:4097/mcp';

async function execInWorkspaceViaManager(
  project: string,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number | null }> {
  const mcpRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'exec_in_workspace',
      arguments: {
        project,
        command,
        mountPath: '/data',
        timeoutSeconds: Math.ceil(timeoutMs / 1000),
        namespace: NAMESPACE,
      },
    },
  };

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mcpRequest),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Manager MCP service returned ${res.status}: ${bodyText.slice(0, 200)}`);
  }

  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new Error('Failed to read response body from manager MCP service');
  }

  let mcpResponse: {
    result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    error?: { message?: string };
  };
  try {
    mcpResponse = JSON.parse(body) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
      error?: { message?: string };
    };
  } catch {
    throw new Error(`Manager MCP returned non-JSON response: ${body.slice(0, 500)}`);
  }

  if (mcpResponse.error) {
    throw new Error(mcpResponse.error.message ?? 'Manager MCP error');
  }

  if (mcpResponse.result?.isError) {
    const errText = mcpResponse.result.content?.[0]?.text ?? 'Unknown MCP error';
    throw new Error(errText);
  }

  const rawText = mcpResponse.result?.content?.[0]?.text ?? '{}';

  let parsed: { stdout?: string; exitCode?: number | null };
  try {
    parsed = JSON.parse(rawText) as {
      stdout?: string;
      exitCode?: number | null;
    };
  } catch {
    throw new Error(`Failed to parse MCP exec response as JSON: ${rawText.slice(0, 500)}`);
  }

  return {
    stdout: parsed.stdout ?? '',
    exitCode: parsed.exitCode ?? null,
  };
}

router.get('/:project/tasks/:taskName/diff', auth(), async (c) => {
  const projectName = c.req.param('project');
  const taskName = c.req.param('taskName');

  if (!projectName || !taskName) {
    return c.json({ error: 'Missing required parameters: project, taskName' }, 400);
  }

  try {
    const [project, task] = await Promise.all([
      getProject(projectName, NAMESPACE),
      getTask(taskName, NAMESPACE),
    ]);

    const worker = task.status?.worker;
    const defaultRef = project.spec.source?.git?.ref ?? 'main';

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

    const source = project.spec.source;
    let repoPath: string;

    if (source?.local) {
      repoPath = '/data/workspace';
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
          reason: 'Project has no git source configured',
        },
        400,
      );
    }

    const cmd = [
      `REPO=${quoteSh(repoPath)}`,
      `BASE=${quoteSh(baseRef)}`,
      `HEAD=${quoteSh(headRef)}`,
      'if [ ! -d "$REPO" ]; then printf \'__PERCUSSIONIST_ERROR__ repo_not_found %s\\n\' "$REPO"; exit 0; fi',
      'git -C "$REPO" fetch origin "+refs/heads/*:refs/remotes/origin/*" --prune 2>/dev/null || echo "[diff] fetch failed, using stale mirror"',
      'RESOLVE() { if git -C "$REPO" rev-parse --verify "origin/$1^{commit}" >/dev/null 2>&1; then printf "origin/%s" "$1"; elif git -C "$REPO" rev-parse --verify "$1^{commit}" >/dev/null 2>&1; then printf "%s" "$1"; fi; }',
      'BASE_REF=$(RESOLVE "$BASE")',
      'HEAD_REF=$(RESOLVE "$HEAD")',
      'if [ -z "$BASE_REF" ]; then printf \'__PERCUSSIONIST_ERROR__ base_missing %s\\n\' "$BASE"; exit 0; fi',
      'if [ -z "$HEAD_REF" ]; then printf \'__PERCUSSIONIST_ERROR__ head_missing %s\\n\' "$HEAD"; exit 0; fi',
      'FORK=$(git -C "$REPO" merge-base "$BASE_REF" "$HEAD_REF" 2>/dev/null)',
      'if git -C "$REPO" merge-base --is-ancestor "$HEAD_REF" "$BASE_REF" 2>/dev/null; then',
      '  MERGE=$(git -C "$REPO" rev-list --merges --ancestry-path "$HEAD_REF".."$BASE_REF" 2>/dev/null | tail -1)',
      '  if [ -n "$MERGE" ]; then',
      '    for PARENT in $(git -C "$REPO" rev-parse "$MERGE^@" 2>/dev/null); do',
      '      if ! git -C "$REPO" merge-base --is-ancestor "$HEAD_REF" "$PARENT" 2>/dev/null; then FORK="$PARENT"; break; fi',
      '    done',
      '  fi',
      'fi',
      'echo "___META___"',
      'printf "BASE_SHA="; git -C "$REPO" rev-parse "$BASE_REF^{commit}" 2>/dev/null; echo',
      'printf "HEAD_SHA="; git -C "$REPO" rev-parse "$HEAD_REF^{commit}" 2>/dev/null; echo',
      'printf "FORK_SHA=%s\\n" "$FORK"',
      'echo "___UNIFIED___"',
      'git -C "$REPO" diff --no-color --find-renames --binary "$FORK..$HEAD_REF" -- 2>/dev/null || true',
      'echo "___COMMITS___"',
      'for SHA in $(git -C "$REPO" rev-list --no-merges "$FORK..$HEAD_REF" 2>/dev/null | head -20); do',
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
    ].join('\n');

    const result = await execInWorkspaceViaManager(projectName, cmd, 120_000);
    const output = result.stdout.trim();

    if (output.includes('__PERCUSSIONIST_ERROR__')) {
      const reason = output
        .slice(output.indexOf('__PERCUSSIONIST_ERROR__'))
        .replace('__PERCUSSIONIST_ERROR__', '')
        .trim();
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

    let metaText = '';
    let unifiedDiff = '';
    let commitsText = '';

    const metaMarker = '___META___\n';
    const unifiedMarker = '___UNIFIED___\n';
    const commitsMarker = '\n___COMMITS___\n';

    const metaIdx = output.indexOf(metaMarker);
    const unifiedIdx = output.indexOf(unifiedMarker);
    const commitsIdx = output.indexOf(commitsMarker);

    if (metaIdx !== -1 && unifiedIdx !== -1) {
      metaText = output.slice(metaIdx + metaMarker.length, unifiedIdx);
    }

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

    const meta = parseMetaSection(metaText);
    const baseSha = meta.baseSha ?? '';
    const headSha = meta.headSha ?? '';
    const forkSha = meta.forkSha ?? '';
    const diffFingerprint = computeDiffFingerprint(forkSha, headSha, unifiedDiff);

    const context: DiffContext = { baseSha, headSha, forkSha, diffFingerprint };
    const findings = projectFindings(task.status?.diffFindings, context);

    const files = unifiedDiff.trim() ? splitDiffByFile(unifiedDiff.trim()) : [];
    const commits = parseCommitsSection(commitsText);

    return c.json({
      project: projectName,
      task: taskName,
      defaultRef,
      baseRef,
      headRef,
      baseSha,
      headSha,
      forkSha,
      diffFingerprint,
      context,
      files,
      findings,
      commits,
      empty: files.length === 0 && commits.length === 0,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

export default router;

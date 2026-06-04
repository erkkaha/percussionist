import { Hono } from "hono";
import { NAMESPACE, getProject, getTask, execInWorkspace } from "../kube.js";

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

const router = new Hono();

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

    const baseRef = worker?.mergeIntoBranch ?? worker?.parentBranch ?? defaultRef;
    const headRef = worker?.gitBranch ?? defaultRef;

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
      "if [ ! -d \"$REPO\" ]; then",
      "  printf '__PERCUSSIONIST_ERROR__ repo_not_found %s\\n' \"$REPO\"",
      "  exit 0",
      "fi",
      "if ! git -C \"$REPO\" rev-parse --verify \"$BASE^{commit}\" >/dev/null 2>&1; then",
      "  printf '__PERCUSSIONIST_ERROR__ base_missing %s\\n' \"$BASE\"",
      "  exit 0",
      "fi",
      "if ! git -C \"$REPO\" rev-parse --verify \"$HEAD^{commit}\" >/dev/null 2>&1; then",
      "  printf '__PERCUSSIONIST_ERROR__ head_missing %s\\n' \"$HEAD\"",
      "  exit 0",
      "fi",
      "git -C \"$REPO\" diff --no-color --find-renames --binary \"$BASE...$HEAD\" -- || git -C \"$REPO\" diff --no-color --find-renames --binary \"$BASE..$HEAD\" --",
    ].join("; ");

    const result = await execInWorkspace(projectName, cmd, "/data", 120_000, NAMESPACE);
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

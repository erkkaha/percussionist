#!/usr/bin/env node
// beatctl — the percussionist CLI.
//
// Subcommands are thin: each one does argument parsing here and delegates to
// a focused module. Global flags (--namespace) are repeated on every command
// rather than hoisted so `beatctl logs foo -n ns` reads naturally.

import { Command } from "commander";
import { runSubmit } from "./submit.js";
import { runLs, runGet } from "./view.js";
import { runLogs } from "./logs.js";
import { runAttach } from "./attach.js";
import { runCancel } from "./cancel.js";
import { runWait } from "./wait.js";
import { runDeploy } from "./deploy.js";
import { runAuthImport } from "./auth.js";
import { runSshKeyCreate } from "./ssh-key.js";
import { runGithubTokenCreate } from "./github-token.js";
import {
  runProjectCreate,
  runProjectDelete,
  runProjectGet,
  runProjectList,
} from "./project.js";
import { runAgentList, runAgentGet, runAgentCreate, runAgentDelete } from "./agent.js";
import {
  runBoardGet,
  runBoardTaskAdd,
  runBoardTaskMove,
  runBoardTaskRemove,
} from "./board.js";
import { DEFAULT_NAMESPACE } from "./kube.js";

const program = new Command();

program
  .name("beatctl")
  .description("CLI for percussionist — orchestrate OpenCode runs on Kubernetes")
  .version("0.1.0");

// deploy --------------------------------------------------------------------
program
  .command("deploy")
  .description("install or remove percussionist CRDs and deployments")
  .option("-n, --namespace <ns>", "namespace for rollout checks", DEFAULT_NAMESPACE)
  .option("--repo-root <path>", "repo root containing crds/ and deploy/", process.cwd())
  .option("--down", "remove deployed resources", false)
  .option("--no-wait", "don't wait for deployment rollout")
  .action(runDeploy);

// submit --------------------------------------------------------------------
program
  .command("submit")
  .description("create a new OpenCodeRun")
  .option("-t, --task <task>", "inline task prompt")
  .option(
    "-i, --interactive",
    "don't dispatch a prompt; keep the runner alive for `beatctl attach`",
  )
  .option(
    "-a, --attach",
    "after submit, wait for Running and attach automatically",
  )
  .option("--name <name>", "run name (auto-generated if omitted)")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("-f, --file <path>", "read run YAML from file")
  .option("--image <image>", "override runner image")
  .option("--agent <agent>", "agent name")
  .option("-m, --model <model>", "model name (e.g. github-copilot/claude-sonnet-4.5)")
  .option("--timeout <seconds>", "hard timeout (seconds)")
  .option("--llm-keys-secret <name>", "Secret with provider API keys")
  .option(
    "--auth-secret <name>",
    "Secret with opencode auth.json (created by `beatctl auth import`)",
  )
  .option(
    "--auth-key <key>",
    "key inside --auth-secret holding auth.json (default: auth.json)",
  )
  .option("--git-url <url>", "git repository URL (ssh or https)")
  .option("--git-ref <ref>", "branch, tag, or commit SHA to clone")
  .option("--git-author-name <name>", "git commit author name for in-run commits")
  .option("--git-author-email <email>", "git commit author email for in-run commits")
  .option(
    "--git-ssh-secret <name>",
    "Secret name containing the SSH private key for private repos (create with `beatctl ssh-key create`)",
  )
  .option(
    "--git-github-token-secret <name>",
    "Secret name containing a GitHub token for gh CLI auth (create with `beatctl github-token create`)",
  )
  .option(
    "--project <name>",
    "OpenCodeProject to use as defaults; explicit flags always override project values",
  )
  // inline agents
  .option("--agent-file <path>", "path to an agent .md file (repeatable)", (val: string, prev: string[] = []) => [...prev, val])
  .option("--agent-name <name>", "override the agent name for the preceding --agent-file (repeatable)", (val: string, prev: string[] = []) => [...prev, val])
  .action(runSubmit);

// ls ------------------------------------------------------------------------
program
  .command("ls")
  .alias("list")
  .description("list OpenCodeRuns in a namespace")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("-A, --all-namespaces", "not yet implemented")
  .action(runLs);

// get -----------------------------------------------------------------------
program
  .command("get <name>")
  .description("show details for a single OpenCodeRun")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("-o, --output <fmt>", "output format (yaml|json)")
  .action((name: string, opts) => runGet(name, opts));

// logs ----------------------------------------------------------------------
program
  .command("logs <name>")
  .description("stream logs from a run's pod (delegates to kubectl logs)")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("-c, --container <name>", "container (opencode|dispatcher)", "opencode")
  .option("-f, --follow", "stream new log lines", false)
  .option("--tail <lines>", "show only the last N lines")
  .action((name: string, opts) => runLogs(name, opts));

// attach --------------------------------------------------------------------
program
  .command("attach <name>")
  .description("port-forward to the run and launch `opencode attach`")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("--local-port <port>", "local port to bind (default: random free port)")
  .action((name: string, opts) => runAttach(name, opts));

// cancel --------------------------------------------------------------------
program
  .command("cancel <name>")
  .alias("rm")
  .description("delete a run (cascades to its pod/service/secret)")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .action((name: string, opts) => runCancel(name, opts));

// wait ----------------------------------------------------------------------
// Exit codes are documented on runWait; intended for CI / `submit && wait`.
program
  .command("wait <name>")
  .description("block until a run reaches a terminal phase (exit 0 on Succeeded)")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option(
    "--timeout <seconds>",
    "abort with exit code 2 if not settled within N seconds",
    "600",
  )
  .option(
    "--for <phase>",
    "wait for a specific phase (e.g. Running, Succeeded); default: any terminal, success=Succeeded",
  )
  .option("-q, --quiet", "suppress the progress line on stderr")
  .action((name: string, opts) => runWait(name, opts));

// ssh-key -------------------------------------------------------------------
// Subcommand group for managing SSH key Secrets used for private repo access.
const sshKey = program.command("ssh-key").description("manage SSH key Secrets for private git repos");

sshKey
  .command("create")
  .description("create or update a kubernetes.io/ssh-auth Secret from a local SSH private key")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option(
    "--name <name>",
    "Secret name to create/update",
    "git-ssh-key",
  )
  .option(
    "--key <path>",
    "path to SSH private key file (default: first found among ~/.ssh/id_ed25519, id_ecdsa, id_rsa)",
  )
  .option("--dry-run", "print what would be created; don't touch the cluster")
  .action(runSshKeyCreate);

// github-token --------------------------------------------------------------
// Subcommand group for managing GitHub token Secrets used for gh CLI auth.
const githubToken = program
  .command("github-token")
  .description("manage GitHub token Secrets for gh CLI authentication in runners");

githubToken
  .command("create")
  .description("create or update an Opaque Secret holding a GitHub personal access token")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("--name <name>", "Secret name to create/update", "git-github-token")
  .option(
    "--token <token>",
    "GitHub personal access token (default: $GITHUB_TOKEN env var)",
  )
  .option("--dry-run", "print what would be created; don't touch the cluster")
  .action(runGithubTokenCreate);

// auth ----------------------------------------------------------------------
// Subcommand group so we can grow `beatctl auth list/rotate/revoke` later
// without another top-level restructure.
const auth = program.command("auth").description("manage opencode provider credentials");

auth
  .command("import")
  .description("copy your local opencode auth.json into a cluster Secret")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option(
    "--name <name>",
    "Secret name to create/update",
    "opencode-auth",
  )
  .option(
    "--key <key>",
    "key inside the Secret that holds auth.json",
    "auth.json",
  )
  .option(
    "-p, --provider <id>",
    "import only this provider (repeatable); default: all",
    (val: string, prev: string[] = []) => [...prev, val],
  )
  .option(
    "--file <path>",
    "override the auth.json source path (default: $XDG_DATA_HOME/opencode/auth.json)",
  )
  .option("--dry-run", "print what would be imported; don't touch the cluster")
  .action(runAuthImport);

// project -------------------------------------------------------------------
// Subcommand group for managing reusable run templates.
const project = program
  .command("project")
  .description("manage OpenCodeProject templates (reusable run defaults)");

project
  .command("list")
  .alias("ls")
  .description("list all projects in a namespace")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .action(runProjectList);

project
  .command("get <name>")
  .description("show a project's spec")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("-o, --output <fmt>", "output format (yaml|json)")
  .action((name: string, opts) => runProjectGet(name, opts));

project
  .command("create")
  .description("create a new project from flags or a YAML file")
  .option("--name <name>", "project name (required unless -f)")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("-f, --file <path>", "read project YAML from file")
  .option("--display-name <name>", "human-readable label")
  .option("--git-url <url>", "git repository URL")
  .option("--git-ref <ref>", "default branch, tag, or SHA")
  .option("--git-author-name <name>", "default git commit author name")
  .option("--git-author-email <email>", "default git commit author email")
  .option("--git-ssh-secret <name>", "Secret with SSH private key")
  .option(
    "--git-github-token-secret <name>",
    "Secret with GitHub token for gh CLI auth (create with `beatctl github-token create`)",
  )
  .option("--llm-keys-secret <name>", "Secret with provider API keys")
  .option(
    "--auth-secret <name>",
    "Secret with opencode auth.json (from `beatctl auth import`)",
  )
  .option("--auth-key <key>", "key inside --auth-secret (default: auth.json)")
  .option("-m, --model <model>", "default model (e.g. anthropic/claude-sonnet-4)")
  .option("--agent <agent>", "default agent (e.g. build, plan)")
  .option("--dry-run", "print YAML; don't apply to cluster")
  .action(runProjectCreate);

project
  .command("delete <name>")
  .alias("rm")
  .description("delete a project")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .action((name: string, opts) => runProjectDelete(name, opts));

// agent ---------------------------------------------------------------------
// Subcommand group for managing cluster-scoped agent definitions.
const agent = program.command("agent").description("manage ClusterAgent resources (cluster-wide agent catalog)");

agent
  .command("list")
  .alias("ls")
  .description("list all ClusterAgents in the cluster")
  .action(runAgentList);

agent
  .command("get <name>")
  .description("show details of a ClusterAgent")
  .option("-o, --output <fmt>", "output format (yaml|json)", "default")
  .action((name: string, opts) => runAgentGet(name, opts));

agent
  .command("create")
  .description("create a new ClusterAgent from flags or a YAML file")
  .option("--name <name>", "agent name (required unless --file)")
  .option("-f, --file <path>", "read agent YAML from file")
  .option("--dry-run", "print YAML; don't apply to cluster")
  .action(runAgentCreate);

agent
  .command("delete <name>")
  .alias("rm")
  .description("delete a ClusterAgent")
  .action((name: string) => runAgentDelete(name));

// board --------------------------------------------------------------------
// Subcommand group for managing the kanban board embedded in an OpenCodeProject.
const board = program.command("board").description("manage the kanban board embedded in an OpenCodeProject");

board
  .command("get <project>")
  .description("show the board state (columns, workers, escalations)")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("-o, --output <fmt>", "output format (yaml|json)", "default")
  .action((projectName: string, opts) => runBoardGet(projectName, opts));

// board task ---------------------------------------------------------------
const boardTask = board.command("task").description("manage tasks on the project board");

boardTask
  .command("add <project>")
  .description("add a task to the board")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("--id <id>", "task ID (e.g. F-104)")
  .option("--title <title>", "task title")
  .option("--description <text>", "acceptance criteria and context")
   .option("--type <type>", "task type: PLAN or BUILD", "PLAN")
   .option("--priority <level>", "priority: high, medium, low", "medium")
   .option("--agent <agent>", "agent name (must be in project board team roster)")
  .option("--column <name>", "target column (default: ready)", "ready")
  .action((projectName: string, opts) => {
    if (!opts.id || !opts.title || !opts.agent) {
      console.error("beatctl: --id, --title, and --agent are required");
      process.exit(1);
    }
    runBoardTaskAdd(projectName, {
      namespace: opts.namespace,
      id: opts.id,
      title: opts.title,
      description: opts.description,
      type: opts.type as "PLAN" | "BUILD",
      priority: opts.priority as "high" | "medium" | "low",
      agent: opts.agent,
      column: opts.column,
    });
  });

boardTask
  .command("move <project>")
  .description("move a task between columns")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("--task-id <id>", "task ID to move")
  .option("--to <column>", "target column name (required)")
  .action((projectName: string, opts) => {
    if (!opts.taskId || !opts.to) {
      console.error("beatctl: --task-id and --to are required");
      process.exit(1);
    }
    runBoardTaskMove(projectName, {
      namespace: opts.namespace,
      taskId: opts.taskId,
      to: opts.to,
    });
  });

boardTask
  .command("remove <project>")
  .description("remove a task from the board")
  .option("-n, --namespace <ns>", "namespace", DEFAULT_NAMESPACE)
  .option("--task-id <id>", "task ID to remove (required)")
  .action((projectName: string, opts) => {
    if (!opts.taskId) {
      console.error("beatctl: --task-id is required");
      process.exit(1);
    }
    runBoardTaskRemove(projectName, {
      namespace: opts.namespace,
      taskId: opts.taskId,
    });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error("beatctl:", (e as Error).message ?? e);
  process.exit(1);
});

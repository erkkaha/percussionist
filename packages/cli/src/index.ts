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
import { runAuthImport } from "./auth.js";
import { DEFAULT_NAMESPACE } from "./kube.js";

const program = new Command();

program
  .name("beatctl")
  .description("CLI for percussionist — orchestrate OpenCode runs on Kubernetes")
  .version("0.1.0");

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
  .option("--model <model>", "model name")
  .option("--timeout <seconds>", "hard timeout (seconds)")
  .option("--llm-keys-secret <name>", "Secret with provider API keys")
  .option(
    "--server-password-secret <name>",
    "Secret with OPENCODE_SERVER_PASSWORD (auto-generated if omitted)",
  )
  .option(
    "--auth-secret <name>",
    "Secret with opencode auth.json (created by `beatctl auth import`)",
  )
  .option(
    "--auth-key <key>",
    "key inside --auth-secret holding auth.json (default: auth.json)",
  )
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

program.parseAsync(process.argv).catch((e) => {
  console.error("beatctl:", (e as Error).message ?? e);
  process.exit(1);
});

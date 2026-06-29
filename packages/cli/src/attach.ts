// `beatctl attach <name>` — attach to the live opencode TUI inside a run pod.
//
// The runner pod runs the opencode TUI inside a detached tmux session named
// "opencode" (see images/runner/opencode-tmux.sh). Attaching is a direct
// `kubectl exec -it` into that tmux session — no port-forward, no local
// `opencode` binary required.
//
// Multiple concurrent attachers (CLI + web dashboard Terminal tab) can join
// the same tmux session for pair programming. Disconnecting (Ctrl-b d or
// closing the terminal) does NOT kill the TUI — the tmux session persists.

import { spawn } from 'node:child_process';
import type { Run } from '@percussionist/api';
import { RunPhase } from '@percussionist/api';
import { DEFAULT_NAMESPACE, fatal, getRun, loadKube } from './kube.js';

export interface AttachOpts {
  namespace?: string;
}

export async function runAttach(name: string, opts: AttachOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();

  let run: Run | undefined;
  try {
    run = await getRun(custom, ns, name);
  } catch (e) {
    fatal(`resolve ${name}`, e);
  }

  // Guard against attaching to a run that's already finished. The pod is gone
  // so kubectl exec would hang or fail with a cryptic error.
  const terminal = [RunPhase.Succeeded, RunPhase.Failed, RunPhase.Cancelled];
  const phase = run.status?.phase;
  if (phase && (terminal as string[]).includes(phase)) {
    console.error(`beatctl: run ${name} is already ${phase}; nothing to attach to.`);
    process.exit(1);
  }

  const podName = run.status?.podName ?? run.metadata.name;

  if (!phase || phase === RunPhase.Pending || phase === RunPhase.Initializing) {
    console.log(
      `beatctl: run is ${phase ?? 'Pending'}; pod may still be starting — exec may take a few seconds.`,
    );
  }

  console.log(`beatctl: attaching to tmux session "opencode" in pod ${podName} (ns ${ns})…`);

  const args = [
    'exec',
    '-it',
    `pod/${podName}`,
    '-c',
    'opencode',
    '-n',
    ns,
    '--',
    'tmux',
    'attach',
    '-t',
    'opencode',
  ];
  const attach = spawn('kubectl', args, {
    stdio: 'inherit',
    env: { ...process.env },
  });
  attach.on('exit', (code) => {
    process.exit(code ?? 0);
  });
  attach.on('error', (e) => {
    fatal('failed to spawn kubectl exec', e);
  });
}

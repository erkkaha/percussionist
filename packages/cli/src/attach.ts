// `beatctl attach <name>` — exec into the run pod and attach to the
// opencode agent session via the opencode TUI.
//
// The runner pod runs `opencode serve` (headless HTTP API server). This
// command execs into the pod and opens `opencode attach` which connects to
// the opencode agent session with a full TUI.

import { spawn } from 'node:child_process';
import { OPENCODE_RUNNER_DEFAULTS, type Run, RunPhase } from '@percussionist/api';
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

  console.log(`beatctl: opening shell in pod ${podName} (ns ${ns})…`);

  const tuiUrl = `http://127.0.0.1:${OPENCODE_RUNNER_DEFAULTS.port}`;
  const args = [
    'exec',
    '-it',
    `pod/${podName}`,
    '-c',
    'opencode',
    '-n',
    ns,
    '--',
    'opencode',
    'attach',
    tuiUrl,
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

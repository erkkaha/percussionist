import type { Run } from '../lib/types';
import { TERMINAL_PHASES } from '../lib/types';

interface OpenOpencodeButtonProps {
  run: Run;
  /** compact = smaller text/padding, used in the list row */
  compact?: boolean;
}

export default function OpenOpencodeButton({ run, compact }: OpenOpencodeButtonProps) {
  const phase = run.status?.phase;
  const webURL = run.status?.webURL;
  const isActive = !phase || !TERMINAL_PHASES.has(phase);

  if (!webURL) return null;

  if (!isActive) {
    const cls = compact
      ? 'rounded border border-border-muted px-2 py-1 text-xs font-medium text-text-dim cursor-not-allowed opacity-50'
      : 'rounded-md border border-border-muted px-3 py-1.5 text-sm font-medium text-text-dim cursor-not-allowed opacity-50';
    return (
      <span title="Run is not active" className={cls}>
        Open web
      </span>
    );
  }

  const cls = compact
    ? 'rounded border border-border-muted px-2 py-1 text-xs font-medium text-text-dim hover:border-border hover:text-text-muted transition-colors'
    : 'rounded-md border border-border-muted px-3 py-1.5 text-sm font-medium text-text-muted hover:border-border hover:text-text transition-colors';

  return (
    <a
      href={webURL}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open opencode web UI: ${webURL}`}
      className={cls}
    >
      Open web
    </a>
  );
}

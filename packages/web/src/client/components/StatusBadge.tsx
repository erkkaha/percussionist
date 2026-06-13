import type { RunPhase } from '../lib/types';
import { Badge, BadgeDot } from './ui/badge';

const VARIANT_MAP: Record<
  string,
  'pending' | 'initializing' | 'running' | 'succeeded' | 'failed' | 'cancelled'
> = {
  Pending: 'pending',
  Initializing: 'initializing',
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
};

export default function StatusBadge({
  phase,
  title,
}: {
  phase?: RunPhase | string;
  title?: string;
}) {
  const label = phase ?? 'Unknown';
  const variant = VARIANT_MAP[label] ?? 'outline';
  return (
    <Badge variant={variant} title={title} className={title ? 'cursor-help' : ''}>
      <BadgeDot variant={variant} />
      {label}
    </Badge>
  );
}

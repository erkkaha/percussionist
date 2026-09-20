import { cn } from '../lib/utils';
import { Badge } from './ui/badge';

/**
 * Neutral badge rendering the run mode (`Interactive` / `Automated`) from the
 * authoritative `spec.interactive` flag. Styling is intentionally plain
 * (`outline`) so it reads as metadata rather than run phase state.
 */
export default function ModeBadge({
  interactive,
  className,
}: {
  interactive?: boolean;
  className?: string;
}) {
  const label = interactive ? 'Interactive' : 'Automated';
  const description = interactive
    ? 'Interactive run — started by a human'
    : 'Automated run — started by the board';
  return (
    <Badge
      variant="outline"
      className={cn('text-text-dim', className)}
      aria-label={`Run mode: ${label}`}
      title={description}
    >
      {label}
    </Badge>
  );
}

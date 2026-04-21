import type { RunPhase } from "../lib/types";

const PHASE_STYLES: Record<string, string> = {
  Pending:
    "bg-phase-pending/15 text-phase-pending border-phase-pending/30",
  Initializing:
    "bg-phase-initializing/15 text-phase-initializing border-phase-initializing/30",
  Running:
    "bg-phase-running/15 text-phase-running border-phase-running/30",
  Succeeded:
    "bg-phase-succeeded/15 text-phase-succeeded border-phase-succeeded/30",
  Failed:
    "bg-phase-failed/15 text-phase-failed border-phase-failed/30",
  Cancelled:
    "bg-phase-cancelled/15 text-phase-cancelled border-phase-cancelled/30",
};

const PHASE_DOTS: Record<string, string> = {
  Pending: "bg-phase-pending",
  Initializing: "bg-phase-initializing animate-pulse",
  Running: "bg-phase-running animate-pulse",
  Succeeded: "bg-phase-succeeded",
  Failed: "bg-phase-failed",
  Cancelled: "bg-phase-cancelled",
};

export default function StatusBadge({ phase }: { phase?: RunPhase | string }) {
  const label = phase ?? "Unknown";
  const style = PHASE_STYLES[label] ?? "bg-zinc-800 text-zinc-400 border-zinc-700";
  const dot = PHASE_DOTS[label] ?? "bg-zinc-500";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${style}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

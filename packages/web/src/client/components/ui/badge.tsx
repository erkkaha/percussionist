import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-mono uppercase",
  {
    variants: {
      variant: {
        pending: "bg-phase-pending/15 text-phase-pending border-phase-pending/30",
        initializing: "bg-phase-initializing/15 text-phase-initializing border-phase-initializing/30",
        running: "bg-phase-running/15 text-phase-running border-phase-running/30",
        succeeded: "bg-phase-succeeded/15 text-phase-succeeded border-phase-succeeded/30",
        failed: "bg-phase-failed/15 text-phase-failed border-phase-failed/30",
        cancelled: "bg-phase-cancelled/15 text-phase-cancelled border-phase-cancelled/30",
        outline: "bg-transparent text-text-dim border-border-muted",
      },
    },
    defaultVariants: {
      variant: "outline",
    },
  },
);

const dotVariants = cva("inline-block h-1.5 w-1.5 rounded-full", {
  variants: {
    variant: {
      pending: "bg-phase-pending",
      initializing: "bg-phase-initializing animate-pulse",
      running: "bg-phase-running animate-pulse",
      succeeded: "bg-phase-succeeded",
      failed: "bg-phase-failed",
      cancelled: "bg-phase-cancelled",
      outline: "bg-border",
    },
  },
  defaultVariants: {
    variant: "outline",
  },
});

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

function BadgeDot({ variant }: { variant: BadgeProps["variant"] }) {
  return <span className={cn(dotVariants({ variant }))} />;
}

export { Badge, BadgeDot, badgeVariants };

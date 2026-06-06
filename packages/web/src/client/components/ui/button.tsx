import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-surface hover:bg-accent/80",
        secondary: "bg-surface-container-high text-text hover:bg-surface-container-highest",
        outline:
          "border border-border-muted text-text-dim hover:border-border hover:text-text-muted",
        ghost: "text-text-dim hover:bg-surface-overlay hover:text-text-muted",
        link: "text-accent underline-offset-4 hover:underline",
        destructive:
          "bg-error-container text-on-error-container hover:bg-error/90 border border-error/30",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  },
);

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

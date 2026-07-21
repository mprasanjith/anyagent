import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

export const buttonVariants = cva("whitespace-nowrap", {
  defaultVariants: { variant: "primary" },
  variants: {
    variant: {
      link: "text-hm-muted text-hm-sm underline decoration-hm-rule-2 underline-offset-[0.3em] transition-colors duration-[120ms] ease-hm-out hover:text-hm-ink hover:decoration-hm-accent",
      primary:
        "inline-block pointer-coarse:min-h-11 rounded-full bg-hm-accent px-6 py-3 font-medium text-hm-accent-ink text-hm-sm no-underline transition-[background-color,transform] duration-[220ms] ease-hm-out hover:-translate-y-[1.5px] active:translate-y-0",
    },
  },
});

export const Button = ({
  className,
  variant,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) => (
  <button
    className={cn(buttonVariants({ variant }), className)}
    type="button"
    {...props}
  />
);

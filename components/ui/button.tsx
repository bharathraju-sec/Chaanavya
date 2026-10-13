import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Chaanavya variants: square, uppercase labels, terracotta for the main action.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-3 rounded-none border text-xs font-semibold tracking-[0.14em] whitespace-nowrap uppercase transition-colors duration-200 outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-terra bg-terra text-white hover:border-terra-hover hover:bg-terra-hover",
        outline: "border-ink bg-transparent text-ink hover:bg-ink hover:text-white",
        quiet: "border-line-strong bg-transparent text-ink hover:border-ink hover:bg-ink hover:text-white",
        light: "border-on-dark bg-on-dark text-ink hover:border-white hover:bg-white",
        ghost: "border-transparent bg-transparent text-ink normal-case tracking-normal hover:text-terra",
        link: "h-auto border-transparent bg-transparent px-0 text-current underline decoration-1 underline-offset-[7px] hover:text-terra",
      },
      size: {
        default: "h-12 px-6",
        sm: "h-11 px-4",
        lg: "h-13 px-8",
        icon: "size-11",
        "icon-sm": "size-11",
      },
    },
    compoundVariants: [{ variant: "link", class: "h-11 px-0" }],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

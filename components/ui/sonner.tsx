"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// Light only: the storefront has no dark theme, so next-themes is not needed.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: "!rounded-none !border-ink !bg-ink !text-white !font-sans !text-sm",
          actionButton: "!rounded-none !bg-terra !text-white !text-[11px] !font-semibold !uppercase !tracking-[0.12em]",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }

"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useCart } from "@/components/cart/cart-provider"
import type { Product } from "@/lib/types"
import { formatMoney } from "@/lib/types"
import { choosableOptions, OptionPicker, useVariantSelection } from "./variant-picker"

export function QuickAdd({ product, label = "Quick add" }: { product: Product; label?: string }) {
  const { add, busy } = useCart()
  const [open, setOpen] = React.useState(false)
  const { selection, variant, missing, choose, reset } = useVariantSelection(product)
  const soldOut = !product.variants.some(v => v.availableForSale)

  if (soldOut) {
    return (
      <Button variant="quiet" className="mt-4 w-full" disabled>
        Currently unavailable
      </Button>
    )
  }

  // Nothing to choose (perfume, jewellery): add straight away.
  if (choosableOptions(product).length === 0 && variant) {
    return (
      <Button variant="quiet" className="mt-4 w-full" disabled={busy || !variant.availableForSale} onClick={() => add(product, variant)}>
        {label}
      </Button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={next => (setOpen(next), next || reset())}>
      <DialogTrigger asChild>
        <Button variant="quiet" className="mt-4 w-full">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100svh-32px)] gap-0 overflow-y-auto bg-paper p-8 sm:max-w-[520px]">
        <DialogHeader className="gap-1">
          <p className="eyebrow">Choose an option</p>
          <DialogTitle className="font-serif text-4xl leading-tight font-medium">{product.title}</DialogTitle>
          <DialogDescription className="text-sm">{variant ? formatMoney(variant.price) : product.description}</DialogDescription>
        </DialogHeader>
        <div className="mt-7">
          <OptionPicker product={product} selection={selection} onChoose={choose} />
        </div>
        <Button
          className="mt-7 h-13 w-full"
          disabled={!variant || !variant.availableForSale || busy}
          onClick={async () => {
            if (variant && (await add(product, variant))) setOpen(false)
          }}
        >
          {variant ? (variant.availableForSale ? "Add to bag" : "Currently unavailable") : `Select ${missing?.toLowerCase() ?? "an option"}`}
        </Button>
        <Button asChild variant="link" size="sm" className="mt-2 justify-self-center text-[13px] font-medium tracking-normal normal-case">
          <Link href="/size-guide">
            View size guide <ArrowRight aria-hidden />
          </Link>
        </Button>
      </DialogContent>
    </Dialog>
  )
}

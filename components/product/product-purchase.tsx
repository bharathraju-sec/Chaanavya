"use client"

import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCart } from "@/components/cart/cart-provider"
import { formatMoney, type Product } from "@/lib/types"
import { OptionPicker, useVariantSelection } from "./variant-picker"
import { WishlistButton } from "./wishlist-button"

export function ProductPurchase({ product }: { product: Product }) {
  const { add, busy } = useCart()
  const { options, selection, variant, missing, choose } = useVariantSelection(product)
  const shown = variant ?? product.variants.find(v => v.availableForSale) ?? product.variants[0]
  const soldOut = !product.variants.some(v => v.availableForSale)

  return (
    <div>
      {shown && <p className="text-lg font-medium">{formatMoney(shown.price)}</p>}
      {options.length > 0 && (
        <div className="mt-8">
          <div className="mb-1 flex justify-end">
            <Link href="/size-guide" className="inline-flex items-center gap-1.5 text-[13px] underline underline-offset-4 hover:text-terra">
              Size guide <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          <OptionPicker product={product} selection={selection} onChoose={choose} />
        </div>
      )}
      <div className="mt-8 flex gap-3">
        <Button className="h-13 flex-1" disabled={soldOut || !variant?.availableForSale || busy} onClick={() => variant && add(product, variant)}>
          {soldOut || (variant && !variant.availableForSale) ? "Currently unavailable" : variant ? "Add to bag" : `Select ${missing?.toLowerCase() ?? "an option"}`}
        </Button>
        <WishlistButton handle={product.handle} title={product.title} className="size-13 rounded-none border border-line-strong bg-transparent" />
      </div>
    </div>
  )
}

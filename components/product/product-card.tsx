import Image from "next/image"
import Link from "next/link"
import type { Product } from "@/lib/types"
import { formatMoney } from "@/lib/types"
import { QuickAdd } from "./quick-add"
import { WishlistButton } from "./wishlist-button"

// Structure follows the 21st.dev "Product Card" (deltacomponents): image well with an overlaid
// wishlist badge, then title and subtitle on the left with the price on the right.
export function ProductCard({ product, actionLabel, tag, priority }: { product: Product; actionLabel?: string; tag?: string; priority?: boolean }) {
  const variant = product.variants.find(v => v.availableForSale) ?? product.variants[0]
  const image = product.featuredImage ?? variant?.image ?? null
  const href = `/products/${product.handle}`

  return (
    <article className="group/card flex min-w-0 flex-col">
      <div className="relative aspect-[4/5] overflow-hidden bg-well">
        <Link href={href} tabIndex={-1} aria-hidden className="absolute inset-0">
          {image && (
            <Image
              src={image.url}
              alt=""
              fill
              priority={priority}
              sizes="(min-width: 1100px) 25vw, (min-width: 600px) 33vw, 50vw"
              className="object-cover transition-transform duration-[600ms] ease-editorial group-hover/card:scale-[1.03]"
            />
          )}
        </Link>
        {tag && <span className="absolute top-3 left-3 bg-paper px-2.5 py-1.5 text-[10px] leading-none font-semibold tracking-[0.14em] uppercase">{tag}</span>}
        <WishlistButton handle={product.handle} title={product.title} className="absolute top-2 right-2" />
      </div>
      <div className="flex flex-1 items-start justify-between gap-3 pt-4 max-sm:flex-col max-sm:gap-1">
        <div className="min-w-0">
          <h3 className="text-[21px] leading-tight max-sm:text-[19px]">
            <Link href={href} className="hover:underline hover:decoration-1 hover:underline-offset-4">
              {product.title}
            </Link>
          </h3>
          {product.description && <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground">{product.description}</p>}
        </div>
        {variant && <strong className="pt-0.5 text-sm font-medium whitespace-nowrap">{formatMoney(variant.price)}</strong>}
      </div>
      <QuickAdd product={product} label={actionLabel} />
    </article>
  )
}

export function ProductGrid({ products, columns = 4, actionLabel, unavailable }: { products: Product[]; columns?: 3 | 4; actionLabel?: string; unavailable?: boolean }) {
  if (unavailable) {
    return (
      <p role="status" className="py-16 text-center font-serif text-2xl">
        The store is temporarily unavailable. Please try again in a few minutes.
      </p>
    )
  }
  if (products.length === 0) {
    return <p className="py-16 text-center font-serif text-2xl">No products are available in this collection yet.</p>
  }
  return (
    <div
      className={
        columns === 4
          ? "grid grid-cols-2 gap-x-3 gap-y-9 sm:gap-x-4 md:grid-cols-3 lg:grid-cols-4 lg:gap-x-6 lg:gap-y-11"
          : "grid grid-cols-2 gap-x-3 gap-y-9 sm:gap-x-4 md:grid-cols-3 lg:gap-x-6 lg:gap-y-11"
      }
    >
      {products.map((product, i) => (
        <ProductCard key={product.id} product={product} actionLabel={actionLabel} priority={i < 2} />
      ))}
    </div>
  )
}

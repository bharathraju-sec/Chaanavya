import type { Product, Variant } from "@/lib/types"

// Variant selection rules for the product page and quick add, kept free of React so they can be tested
// directly. Prices and availability are whatever the API sent; nothing is computed or assumed here.

export type Selection = Record<string, string>

/** Options a shopper actually has to choose (a single-value "Title" option is skipped). */
export const choosableOptions = (product: Product) => product.options.filter(o => o.values.length > 1)

export const variantMatches = (variant: Variant, selection: Selection) =>
  Object.entries(selection).every(([name, value]) => variant.selectedOptions.some(o => o.name === name && o.value === value))

/** Single-value options are preselected, so a product with no real choice resolves to its only variant at once. */
export const fixedSelection = (product: Product): Selection => Object.fromEntries(product.options.filter(o => o.values.length === 1).map(o => [o.name, o.values[0]]))

/** The shopper's choices for a requested variant (a shared link or an earlier choice); empty when it is not one of this product's variants. */
export function selectionFor(product: Product, variantId?: string | null): Selection {
  const variant = variantId ? product.variants.find(v => v.id === variantId) : undefined
  return variant ? Object.fromEntries(variant.selectedOptions.map(o => [o.name, o.value])) : {}
}

/** The variant a complete selection names, or none while a choice is missing. */
export function resolveVariant(product: Product, selection: Selection): Variant | undefined {
  if (product.variants.length === 1) return product.variants[0]
  return choosableOptions(product).every(o => selection[o.name]) ? product.variants.find(v => variantMatches(v, selection)) : undefined
}

/** A value is offered when some available variant has it alongside the other current choices. */
export function valueAvailable(product: Product, selection: Selection, name: string, value: string) {
  const others = Object.fromEntries(Object.entries(selection).filter(([key]) => key !== name))
  return product.variants.some(v => v.availableForSale && variantMatches(v, { ...others, [name]: value }))
}

/** The variant whose price is shown: the chosen one, else the first that can be bought, else the first. */
export const shownVariant = (product: Product, chosen?: Variant) => chosen ?? product.variants.find(v => v.availableForSale) ?? product.variants[0]

export const isSoldOut = (product: Product) => !product.variants.some(v => v.availableForSale)

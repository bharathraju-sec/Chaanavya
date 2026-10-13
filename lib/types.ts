export type Money = { amount: string; currencyCode: string }

export type ProductImage = { url: string; altText: string | null; width?: number | null; height?: number | null }

export type Variant = {
  id: string
  title: string
  availableForSale: boolean
  price: Money
  image?: ProductImage | null
  selectedOptions: { name: string; value: string }[]
}

export type Product = {
  id: string
  handle: string
  title: string
  description: string
  productType: string
  tags: string[]
  featuredImage: ProductImage | null
  images: ProductImage[]
  variants: Variant[]
  /** Options with their values, e.g. Size: S, M, L. Options with a single value are hidden in the UI. */
  options: { name: string; values: string[] }[]
  /** Only set on the built-in fallback catalogue, which has no Shopify collections. */
  collections?: string[]
}

export type CartLine = {
  id: string
  quantity: number
  title: string
  handle: string
  option: string
  image: string
  price: Money
}

export const formatMoney = (money: Money | number | undefined) => {
  const amount = typeof money === "number" ? money : Number(money?.amount ?? 0)
  const currency = typeof money === "object" && money?.currencyCode ? money.currencyCode : "INR"
  const digits = Number.isInteger(amount) ? 0 : 2
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
}

export const optionLabel = (title: string) => (title === "Default Title" ? "One Size" : title)
